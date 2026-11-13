import {
  readJson,
  requireId,
  mediaFromBody,
  performerFromBody,
} from "../parse.ts";
import { type AuthContext, json } from "../admission.ts";
import type {
  CatalogDetail,
  MediaReference,
  RequestListItem,
  RequestListResponse,
  RequestRecord,
} from "../../../../lib/contracts.ts";
import {
  isDeliverableMedia,
  UNDELIVERABLE_REASON,
} from "../../../../lib/contracts.ts";
import {
  REQUEST_PAGE_MAX,
  REQUEST_PAGE_SIZE,
  REQUEST_SORTS,
  REQUEST_STATUSES,
  REQUEST_TYPES,
} from "../../../../lib/decisions.ts";
import {
  cancelRequest,
  countDecidablePending,
  createRequest,
  decideRequest,
  getAccount,
  getAcquisitionByReference,
  acquisitionView,
  listAccounts,
  listActiveIntentKeys,
  listRequestPage,
  type RequestPageQuery,
} from "../../../../server/storage.ts";
import { AppError } from "../../../../server/http.ts";
import { searchCatalog } from "../../../../server/providers.ts";

// Creates one user's request intent from a server-validated MediaReference.
// With the autoApprove grant — or an admin role, which carries the same trust
// implicitly (Seerr parity; the owner account cannot be granted the flag in
// the UI because it is already staff) — the request is decided approved
// immediately so shared acquisition work is enqueued; otherwise it stays
// pending for a moderator. No Whisparr call happens anywhere on this path.
export async function createRequestRoute(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const media = mediaFromBody(await readJson(request));
  const record = createRequest(ctx.account.id, media);
  const approved = autoApprove(ctx.account.id, record);
  if (approved) {
    return json({ request: approved, autoApproved: true }, 201);
  }
  return json({ request: record }, 201);
}

/** The session snapshot can predate a revoked grant or role: the body read
 * and a bulk scan's provider pages both await before this runs. So the gate
 * reads the stored account, with no await before decideRequest, which checks
 * it again in its transaction. A revoked grant leaves the new request pending
 * for a moderator, also for a moderator whose role alone could approve. */
function autoApprove(
  accountId: string,
  record: RequestRecord,
): RequestRecord | null {
  const current = getAccount(accountId);
  if (!current?.enabled) return null;
  if (!current.autoApprove && current.role !== "admin") return null;
  return decideRequest(current, record.id, "approved");
}

/** Approved rows carry the SHARED acquisition state for their identity, so a
 * viewer can see whether the work actually went through. Staff viewers also
 * get requester names: the shape both the requests list and the discover
 * rail serve, without exposing anyone else's request history. */
export function listRequestItems(
  ctx: AuthContext,
  query: RequestPageQuery,
): { requests: RequestListItem[]; nextCursor: string | null } {
  const staff =
    ctx.account.role === "admin" || ctx.account.role === "moderator";
  // One map lookup per row instead of one account fetch per row.
  const accounts = staff ? new Map(listAccounts().map((a) => [a.id, a])) : null;
  const page = listRequestPage(ctx.account, query);
  const requests = page.requests.map((r): RequestListItem => {
    const acc = accounts?.get(r.accountId);
    const item: RequestListItem = acc
      ? { ...r, requestedBy: acc.name, requestedById: acc.id }
      : r;
    if (item.decision !== "approved") return item;
    const a = getAcquisitionByReference(item.media);
    return {
      ...item,
      acquisition: acquisitionView(a),
    };
  });
  return { requests, nextCursor: page.nextCursor };
}

function queryChoice<T extends string>(
  params: URLSearchParams,
  key: string,
  choices: readonly T[],
  fallback: T,
): T {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const choice = choices.find((c) => c === raw);
  if (choice === undefined) {
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  }
  return choice;
}

function queryLimit(params: URLSearchParams): number {
  const raw = params.get("limit");
  if (raw === null) return REQUEST_PAGE_SIZE;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > REQUEST_PAGE_MAX) {
    throw new AppError(400, "invalid_field", "Invalid limit.");
  }
  return value;
}

export async function listRequestsRoute(
  ctx: AuthContext,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const page = listRequestItems(ctx, {
    type: queryChoice(params, "type", REQUEST_TYPES, "all"),
    status: queryChoice(params, "status", REQUEST_STATUSES, "all"),
    sort: queryChoice(params, "sort", REQUEST_SORTS, "recent"),
    cursor: params.get("cursor"),
    limit: queryLimit(params),
  });
  return json({
    ...page,
    pendingApprovals: countDecidablePending(ctx.account),
  } satisfies RequestListResponse);
}

export async function decideRequestRoute(
  request: Request,
  ctx: AuthContext,
  id: string,
): Promise<Response> {
  const decision = (await readJson(request)).decision;
  const requestId = requireId(id);
  if (decision === "approved" || decision === "declined") {
    return json({
      request: decideRequest(ctx.account, requestId, decision),
    });
  }
  if (decision === "cancelled") {
    return json({ request: cancelRequest(ctx.account, requestId) });
  }
  throw new AppError(
    400,
    "invalid_field",
    "decision must be approved, declined, or cancelled.",
  );
}

export const BULK_REQUEST_CAP = 100;
// A provider page, not the cap: TPDB rejects (oversized response) a
// filmography page of 100 rows. 24 is what the browse surfaces request.
export const BULK_SCAN_PAGE = 24;
// ponytail: a fixed read budget per pass. Five fully readable pages fill the
// cap; ten (240 rows) leave headroom for rows the mapper drops. Raw provider
// continuation alone never ends a listing of unreadable rows (TPDB lists up
// to 10000), so a pass that has not filled the cap stops here, named. With
// active-intent pre-filtering the same budget bounds the re-run's skip walk;
// a performer with more titles than the ceiling leaves the tail unreachable
// until a pass resumes from a provider cursor instead of page 1.
export const BULK_SCAN_PAGES = 10;

type BulkScanStop = {
  code: "scan_ceiling" | "unreadable_page";
  message: string;
};

export async function bulkRequestRoute(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const body = await readJson(request);
  const performer = performerFromBody(body);
  const kind = body.kind;
  if (kind !== "movie" && kind !== "scene") {
    throw new AppError(400, "invalid_field", "Invalid kind.");
  }
  if (performer.provider === "stashdb" && kind === "movie") {
    throw new AppError(400, "invalid_query", "StashDB has no movie records.");
  }
  // Same rule as a single request: filing a hundred requests Whisparr can
  // never resolve is the same mistake, a hundred times.
  if (!isDeliverableMedia({ provider: performer.provider, kind })) {
    throw new AppError(400, "invalid_reference", UNDELIVERABLE_REASON);
  }
  // One sequential pass, hard-capped at BULK_REQUEST_CAP unfiled titles and
  // bounded by BULK_SCAN_PAGES provider pages: a prolific performer needs
  // re-runs to continue the backlog, which is exactly what the UI copy and
  // the `capped` flag promise. Re-running is safe because the active-intent
  // unique index makes every createRequest idempotent.
  //
  // Titles the account already holds an active intent for never count
  // toward the cap — they are pre-skipped below (and still surface in
  // `skipped`), so a re-run reaches the unfiled backlog past them instead
  // of re-collecting the same first 100 rows. The key format matches
  // listActiveIntentKeys ("<provider>:<kind>:<id>"); the set also dedupes
  // rows the provider repeats within one pass.
  const activeKeys = listActiveIntentKeys(ctx.account.id);
  const items: CatalogDetail[] = [];
  let scanned = 0;
  let stopped: BulkScanStop | undefined;
  let more = false;
  let skipped = 0;
  for (let page = 1; ; page += 1) {
    // TPDB's performer filter is paging-only: no other filter may travel
    // with it. StashDB composes freely but has no movie entity.
    //
    // The page size is BULK_SCAN_PAGE, not the cap: a TPDB filmography page
    // of 100 titles exceeds the provider client's response byte ceiling and
    // comes back as 502 upstream_bad_response, so the scan pages in the same
    // size the browse surfaces use.
    const result = await searchCatalog(
      performer.provider === "tpdb"
        ? {
            provider: "tpdb",
            kind,
            performer: performer.id,
            page,
            perPage: BULK_SCAN_PAGE,
          }
        : {
            provider: "stashdb",
            kind: "scene",
            performer: performer.id,
            page,
            perPage: BULK_SCAN_PAGE,
          },
    );
    scanned += result.items.length;
    more = result.hasMore;
    for (const item of result.items) {
      const key = `${performer.provider}:${kind}:${item.reference.id}`;
      if (activeKeys.has(key)) {
        skipped += 1;
        continue;
      }
      activeKeys.add(key);
      items.push(item);
    }
    if (items.length >= BULK_REQUEST_CAP) break;
    if (!more) break;
    // Continuation is left but the pass ends here: more titles may remain,
    // and the named stop says why the walk ended short of the cap.
    if (result.items.length === 0) {
      stopped = {
        code: "unreadable_page",
        message: `Stopped at provider page ${page}: it held no readable titles, so later titles were not requested.`,
      };
      break;
    }
    if (page >= BULK_SCAN_PAGES) {
      stopped = {
        code: "scan_ceiling",
        message: `Stopped at the ${BULK_SCAN_PAGES}-page scan limit before the listing ended, so later titles were not requested.`,
      };
      break;
    }
  }
  const overflow = items.length > BULK_REQUEST_CAP;
  if (overflow) items.length = BULK_REQUEST_CAP;
  // capped means another pass has something left: the provider still
  // advertises pages (`more`), or scanned rows were dropped at the cap
  // (`overflow`). A filmography that ran dry never reports capped.
  const capped = more || overflow;
  let requested = 0;
  let autoApproved = 0;
  const failed: { id: string; code: string }[] = [];
  for (const item of items) {
    // kind is pinned movie/scene above; the reference came from that query.
    const media: MediaReference = {
      provider: performer.provider,
      kind,
      id: item.reference.id,
    };
    try {
      const record = createRequest(ctx.account.id, media);
      requested += 1;
      if (autoApprove(ctx.account.id, record)) autoApproved += 1;
    } catch (err) {
      if (err instanceof AppError && err.code === "request_exists") {
        skipped += 1;
      } else if (err instanceof AppError) {
        failed.push({ id: media.id, code: err.code });
      } else {
        throw err;
      }
    }
  }
  return json({
    requested,
    skipped,
    autoApproved,
    failed,
    scanned,
    capped,
    ...(stopped !== undefined ? { error: stopped } : {}),
  });
}

import type { RouteDef } from "../admission.ts";

export const routes: RouteDef[] = [
  {
    method: "GET",
    segments: ["requests"],
    auth: "session",
    run: async (ctx, request) => listRequestsRoute(ctx, request),
  },
  {
    method: "POST",
    segments: ["requests"],
    auth: "session",
    run: async (ctx, request) => createRequestRoute(request, ctx),
  },
  {
    method: "POST",
    segments: ["requests", "bulk"],
    auth: "session",
    run: async (ctx, request) => bulkRequestRoute(request, ctx),
  },
  {
    method: "PATCH",
    segments: ["requests", ":id"],
    auth: "session",
    run: async (ctx, request, p) => decideRequestRoute(request, ctx, p.id!),
  },
];
