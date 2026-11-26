import {
  readJson,
  fieldText,
  parseCatalogReference,
  performerFromBody,
  performerField,
} from "../parse.ts";
import { type AuthContext, json } from "../admission.ts";
import { AppError, sourceError } from "../../../../server/http.ts";
import type {
  CatalogDetail,
  CatalogReference,
  SourceError,
} from "../../../../lib/contracts.ts";
import {
  followPerformerPair,
  listFollows,
  mergePerformerFollows,
  unfollowPerformer,
} from "../../../../server/storage.ts";
import {
  getCatalogDetail,
  isProviderImageUrl,
  linkedPerformerCounterpart,
} from "../../../../server/providers.ts";

export async function listFollowsRoute(ctx: AuthContext): Promise<Response> {
  return json({ follows: listFollows(ctx.account.id) });
}

/** The same performer on the other provider, taken only from links the
 * providers themselves published (never name-matched): an explicit
 * cross-provider URL first, then a shared third-party profile link
 * (identity URL match). The counterpart's own snapshot is read from that
 * provider. A metadata outage must not sink the follow the user asked for,
 * but it is never allowed to read as "no published link": a failed lookup
 * returns the named `failure` beside the counterpart-less result, so the
 * follow creation can say the pairing is unknown rather than absent. */
export async function performerCounterpart(
  reference: CatalogReference,
): Promise<{
  counterpart: {
    reference: CatalogReference;
    name: string;
    imageUrl: string | null;
  } | null;
  failure: SourceError | null;
}> {
  try {
    const detail = await getCatalogDetail(reference);
    const link = detail ? await linkedPerformerCounterpart(detail) : undefined;
    if (!link?.linked) {
      return { counterpart: null, failure: link?.failure ?? null };
    }
    let counterpart: CatalogDetail | null;
    try {
      counterpart = await getCatalogDetail(link.linked);
    } catch (err) {
      // The counterpart's own provider failed; attribute the error to it.
      return {
        counterpart: null,
        failure: sourceError(link.linked.provider, err),
      };
    }
    if (!counterpart) return { counterpart: null, failure: null };
    return {
      counterpart: {
        reference: link.linked,
        name: counterpart.title,
        imageUrl: followImage(counterpart.imageUrl),
      },
      failure: null,
    };
  } catch (err) {
    // Only the primary detail read lands here: attribute it to this provider.
    return { counterpart: null, failure: sourceError(reference.provider, err) };
  }
}

/** An image URL that fails the provider-artwork check degrades to null
 * rather than sinking the whole follow: the snapshot is cosmetic. */
function followImage(raw: unknown): string | null {
  return typeof raw === "string" && raw !== "" && isProviderImageUrl(raw).ok
    ? raw
    : null;
}

export async function createFollowRoute(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const body = await readJson(request);
  const reference = performerFromBody(body);
  // A performer is one person on both metadata sources, so one Follow press
  // follows both: the pair then answers as one identity everywhere.
  const { counterpart, failure } = await performerCounterpart(reference);
  // Both rows commit together or not at all: a fault on the counterpart
  // write answers honestly with nothing saved, so the client's "not
  // following" state matches storage and a retry starts clean.
  const follow = followPerformerPair(
    ctx.account.id,
    reference,
    fieldText(body, "name", 200),
    followImage(body.imageUrl),
    counterpart,
  );
  // A failed counterpart lookup keeps the follow but never reads as
  // complete: the named error says the pairing is unknown, not absent.
  return json({ follow, ...(failure ? { errors: [failure] } : {}) }, 201);
}

export async function deleteFollowRoute(
  ctx: AuthContext,
  providerRaw: string,
  idRaw: string,
): Promise<Response> {
  const reference = parseCatalogReference(providerRaw, "performer", idRaw);
  unfollowPerformer(ctx.account.id, reference.provider, reference.id);
  return new Response(null, { status: 204 });
}

/** A follow snapshot of `reference` taken from its provider detail with the
 * same rules as a Follow press; a missing record is a 404. */
async function followSnapshot(
  reference: CatalogReference,
): Promise<{ name: string; imageUrl: string | null }> {
  const detail = await getCatalogDetail(reference);
  if (!detail) {
    throw new AppError(
      404,
      "catalog_not_found",
      "This item is not in the provider catalog.",
    );
  }
  return { name: detail.title, imageUrl: followImage(detail.imageUrl) };
}

/** Merges two entries the user asserts are the same person and the providers
 * never linked. Either side that is not followed yet is followed on the
 * spot, its snapshot taken from the provider detail with the same rules as a
 * Follow press, so one Merge click on a match suggestion follows both. The
 * survivor (`performer`) row names the counterpart, exactly as a
 * provider-published pair would. */
export async function mergeFollowsRoute(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const body = await readJson(request);
  const performer = performerField(body, "performer");
  const counterpart = performerField(body, "counterpart");
  if (performer.provider === counterpart.provider) {
    throw new AppError(
      400,
      "invalid_field",
      "a merge pairs a TPDB entry with a StashDB entry",
    );
  }
  // Existing follows keep their snapshots and do not depend on provider reads.
  const follows = listFollows(ctx.account.id);
  const followed = (ref: CatalogReference) =>
    follows.some(
      (f) =>
        (f.reference.provider === ref.provider && f.reference.id === ref.id) ||
        (f.linked?.provider === ref.provider && f.linked?.id === ref.id),
    );
  const autoFollow = followed(performer)
    ? undefined
    : await followSnapshot(performer);
  const autoFollowAbsorbed = followed(counterpart)
    ? undefined
    : await followSnapshot(counterpart);
  const follow = mergePerformerFollows(
    ctx.account.id,
    performer,
    counterpart,
    autoFollow,
    autoFollowAbsorbed,
  );
  return json({ follow }, 200);
}

import type { RouteDef } from "../admission.ts";

export const routes: RouteDef[] = [
  {
    method: "GET",
    segments: ["follows"],
    auth: "session",
    run: async (ctx) => listFollowsRoute(ctx),
  },
  {
    method: "POST",
    segments: ["follows"],
    auth: "session",
    run: async (ctx, request) => createFollowRoute(request, ctx),
  },
  {
    method: "POST",
    segments: ["follows", "merge"],
    auth: "session",
    run: async (ctx, request) => mergeFollowsRoute(request, ctx),
  },
  {
    method: "DELETE",
    segments: ["follows", ":provider", ":id"],
    auth: "session",
    run: async (ctx, _request, p) => deleteFollowRoute(ctx, p.provider!, p.id!),
  },
];
