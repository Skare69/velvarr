// Natural-language search on Browse: the chat draft (./prose-chat.ts) goes
// through the map (../lib/prose-map.ts) with the real provider adapters
// below, and the browse parser and planner check the result before the
// member sees it, so a patch Browse would refuse is never applied.

import type { BrowseTab } from "../lib/browse-entities.ts";
import type { IntegrationConfig } from "../lib/contracts.ts";
import {
  mapProseDraft,
  type ProseLookups,
  type ProseSearchResult,
} from "../lib/prose-map.ts";
import type { ProseDraft } from "../lib/prose-draft.ts";
import {
  applyTagRepair,
  candidateWords,
  rankCandidates,
  REPAIR_PHRASES_MAX,
  type MissedTag,
  type RepairItem,
  type RepairPicks,
} from "../lib/prose-repair.ts";
import { parseBrowseQuery, planBrowseSides } from "./browse.ts";
import { AppError } from "./http.ts";
import {
  requestProseDraft,
  requestTagRepair,
  serverToday,
} from "./prose-chat.ts";
import {
  getCatalogDetail,
  linkedPerformerCounterpart,
  providerConfigured,
  searchCatalog,
  searchCatalogTags,
  studioCounterpart,
} from "./providers.ts";

// A 400 from a provider search is a term the provider cannot search (empty
// after cleaning): no rows, not an outage. Every other error propagates and
// the map names it in a lookup_failed note.
async function rowsOrEmpty<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof AppError && err.status === 400) return [];
    throw err;
  }
}

export const serverProseLookups: ProseLookups = {
  configured: providerConfigured,
  searchTags: (provider, word) =>
    rowsOrEmpty(() => searchCatalogTags(provider, word)),
  searchNames: (provider, kind, name) =>
    rowsOrEmpty(async () => {
      const page = await searchCatalog(
        provider === "tpdb"
          ? { provider: "tpdb", kind, query: name, page: 1 }
          : { provider: "stashdb", kind, query: name },
      );
      return page.items.map((item) => ({
        id: item.reference.id,
        name: item.title,
        aliases: item.aliases,
      }));
    }),
  counterpart: async (kind, provider, id) => {
    if (kind === "studio") {
      return (await studioCounterpart({ provider, kind: "studio", id }))?.id;
    }
    const detail = await getCatalogDetail({ provider, kind: "performer", id });
    if (detail === null) return undefined;
    const link = await linkedPerformerCounterpart(detail);
    if (link.failure !== undefined) throw new Error(link.failure.message);
    return link.linked?.id;
  },
};

export async function runProseSearch(input: {
  text: string;
  tab: BrowseTab;
  providers: IntegrationConfig["providers"];
  lookups?: ProseLookups;
  today?: string;
  /** Tests replace the repair chat request. */
  repair?: (items: RepairItem[]) => Promise<RepairPicks>;
}): Promise<ProseSearchResult> {
  const draft = await requestProseDraft(
    input.providers,
    input.text,
    input.today ?? serverToday(),
  );
  const lookups = input.lookups ?? serverProseLookups;
  const missed: MissedTag[] = [];
  let result = await mapProseDraft(
    { prose: input.text, tab: input.tab, draft },
    lookups,
    missed,
  );
  if (missed.length > 0) {
    result = await repairMissedTags({
      text: input.text,
      tab: input.tab,
      draft,
      missed,
      lookups,
      result,
      repair:
        input.repair ??
        ((items) => requestTagRepair(input.providers, input.text, items)),
    });
  }
  if (result.params !== null) assertBrowseAccepts(result.params, input.tab);
  return result;
}

/** Pass 2 (docs/specs/prose-tag-repair.md): real candidate tags for each
 * missed phrase, one repair request, and a second map of the repaired draft.
 * Without candidates or picks, pass 1 stands; a failed request keeps pass 1
 * and adds one note. */
export async function repairMissedTags(input: {
  text: string;
  tab: BrowseTab;
  draft: ProseDraft;
  missed: MissedTag[];
  lookups: ProseLookups;
  result: ProseSearchResult;
  repair: (items: RepairItem[]) => Promise<RepairPicks>;
}): Promise<ProseSearchResult> {
  const { lookups, result } = input;
  const providers = (["tpdb", "stashdb"] as const).filter((p) =>
    lookups.configured(p),
  );
  const phrases = [...new Set(input.missed.map((m) => m.value))].slice(
    0,
    REPAIR_PHRASES_MAX,
  );
  const items: RepairItem[] = [];
  for (const phrase of phrases) {
    const rows: { name: string; provider: "tpdb" | "stashdb" }[] = [];
    for (const word of candidateWords(phrase)) {
      for (const provider of providers) {
        try {
          for (const row of await lookups.searchTags(provider, word))
            rows.push({ name: row.name, provider });
        } catch {
          // A failed word search only narrows the candidates; pass 1 already
          // named any provider outage in its notes.
        }
      }
    }
    const candidates = rankCandidates(phrase, rows);
    if (candidates.length > 0) items.push({ phrase, candidates });
  }
  if (items.length === 0) return result;
  let picks: RepairPicks;
  try {
    picks = await input.repair(items);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ...result,
      notes: [
        ...result.notes,
        {
          code: "lookup_failed",
          message: `Tag matching with the AI service failed: ${reason}`,
        },
      ],
    };
  }
  if (picks.size === 0) return result;
  return mapProseDraft(
    {
      prose: input.text,
      tab: input.tab,
      draft: applyTagRepair(input.draft, input.missed, picks),
    },
    lookups,
    [],
    new Set([...picks.values()].flat()),
  );
}

// The final check: the patch, read as the URL it produces, must parse and
// plan exactly as a Browse request would. A refusal is a map bug, so
// nothing is applied rather than a half-valid filter set.
function assertBrowseAccepts(
  params: Record<string, string | null>,
  tab: BrowseTab,
): void {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "type" || value === null || value === "") continue;
    sp.set(key, value);
  }
  const type = "type" in params ? (params.type ?? "all") : tab;
  if (type !== "all") sp.set("type", type);
  try {
    planBrowseSides(parseBrowseQuery(sp));
  } catch {
    throw new AppError(
      500,
      "prose_search_internal",
      "Natural-language search built a filter set that Browse refuses.",
    );
  }
}
