import {
  isDeliverableMedia,
  type CatalogReference,
  type MediaReference,
} from "./contracts.ts";

/** One press files at most this many requests, so a mis-click on a large
 * grid cannot flood the queue. The rest wait for the next press. */
export const REQUEST_ALL_CAP = 20;
export const REQUEST_ALL_CONCURRENCY = 3;

/** "<provider>:<kind>:<id lowercased>" — same spelling as the server's
 * intentKey, so a settled key matches the stored active intent. */
export function requestAllKey(ref: {
  provider: string;
  kind: string;
  id: string;
}): string {
  return `${ref.provider}:${ref.kind}:${ref.id.toLowerCase()}`;
}

export type RequestAllPlan = {
  /** First `cap` eligible refs, in display order. */
  batch: MediaReference[];
  /** Eligible refs beyond the cap (left for the next press). */
  over: number;
  /** Refs isDeliverableMedia rejects (TPDB scenes etc.). */
  undeliverable: number;
};

function asMedia(ref: CatalogReference): MediaReference | null {
  if (!isDeliverableMedia(ref)) return null;
  const { provider, kind, id } = ref;
  return kind === "movie" || kind === "scene" ? { provider, kind, id } : null;
}

/** Walk items in order. Not deliverable → undeliverable++. Key already in
 * `done` → skip silently (settled by an earlier press). Duplicate key → skip.
 * Then first `cap` → batch, the rest → over. */
export function planRequestAll(
  items: readonly { reference: CatalogReference }[],
  done: ReadonlySet<string>,
  cap: number = REQUEST_ALL_CAP,
): RequestAllPlan {
  const batch: MediaReference[] = [];
  const seen = new Set<string>();
  let over = 0;
  let undeliverable = 0;
  for (const { reference } of items) {
    const media = asMedia(reference);
    if (media === null) {
      undeliverable++;
      continue;
    }
    const key = requestAllKey(media);
    if (done.has(key) || seen.has(key)) continue;
    seen.add(key);
    if (batch.length < cap) batch.push(media);
    else over++;
  }
  return { batch, over, undeliverable };
}

export type RequestAllResult = {
  /** POST succeeded (includes auto-approved). */
  requested: number;
  /** Subset of `requested` with autoApproved: true. */
  autoApproved: number;
  /** request_exists. */
  existing: number;
  /** Any other error, the request_limit stop included. */
  failed: number;
  /** Never started because a request_limit stop came first. */
  notSent: number;
  /** The request_limit error, if any. */
  stopped: { code: string; message: string } | null;
  /** requestAllKey of every requested or existing ref. */
  settled: string[];
};

function errorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || !("code" in e)) return undefined;
  return typeof e.code === "string" ? e.code : undefined;
}

/** At most `concurrency` posts in flight. On a `request_limit` error no new
 * post starts: the account's pending cap would refuse every later one too.
 * In-flight posts finish and are counted. Never throws for a post rejection. */
export async function runRequestAll(
  batch: readonly MediaReference[],
  post: (ref: MediaReference) => Promise<{ autoApproved?: boolean }>,
  concurrency: number = REQUEST_ALL_CONCURRENCY,
): Promise<RequestAllResult> {
  const result: RequestAllResult = {
    requested: 0,
    autoApproved: 0,
    existing: 0,
    failed: 0,
    notSent: 0,
    stopped: null,
    settled: [],
  };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (result.stopped === null) {
      const ref = batch[next];
      if (ref === undefined) return;
      next++;
      try {
        const res = await post(ref);
        result.requested++;
        if (res.autoApproved === true) result.autoApproved++;
        result.settled.push(requestAllKey(ref));
      } catch (e) {
        const code = errorCode(e);
        if (code === "request_exists") {
          result.existing++;
          result.settled.push(requestAllKey(ref));
          continue;
        }
        result.failed++;
        if (code === "request_limit" && result.stopped === null) {
          result.stopped = {
            code,
            message: e instanceof Error ? e.message : String(e),
          };
        }
      }
    }
  };
  const workers = Math.min(Math.max(1, Math.floor(concurrency)), batch.length);
  await Promise.all(Array.from({ length: workers }, worker));
  result.notSent = batch.length - next;
  return result;
}
