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
import { parseBrowseQuery, planBrowseSides } from "./browse.ts";
import { AppError } from "./http.ts";
import { requestProseDraft, serverToday } from "./prose-chat.ts";
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
}): Promise<ProseSearchResult> {
  const draft = await requestProseDraft(
    input.providers,
    input.text,
    input.today ?? serverToday(),
  );
  const result = await mapProseDraft(
    { prose: input.text, tab: input.tab, draft },
    input.lookups ?? serverProseLookups,
  );
  if (result.params !== null) assertBrowseAccepts(result.params, input.tab);
  return result;
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
