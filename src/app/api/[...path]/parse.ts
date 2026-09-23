// Moved verbatim from route.ts (v0.24.1) — pure move, no logic edits.
import { createHash } from "node:crypto";
import type {
  Account,
  AdminAccount,
  CatalogDetail,
  CatalogKind,
  CatalogProvider,
  CatalogReference,
  CatalogTagSelection,
  ExternalUser,
  IntegrationConfig,
  Library,
  LibraryItem,
  MediaKind,
  MediaReference,
  ProviderStatus,
  RequestListItem,
  RequestRecord,
  Role,
  WhisparrDelivery,
  WhisparrPathMapping,
} from "../../../lib/contracts.ts";
import {
  isDeliverableMedia,
  isRemovalLevel,
  normalizeFacetName,
  UNDELIVERABLE_REASON,
} from "../../../lib/contracts.ts";
import {
  approveRemovalRequest,
  bootstrap,
  cancelRemovalRequest,
  cancelRequest,
  countRequestsByAccount,
  createRemovalRequest,
  createRequest,
  createSession,
  decideRequest,
  declineRemovalRequest,
  followPerformer,
  getAcquisitionByReference,
  getAccount,
  getConfig,
  getContentPreferences,
  getSession,
  hasAuthoritativeAbsence,
  importAccounts,
  isInitialized,
  isObservationStale,
  listAccounts,
  listFollows,
  listFollowsByProvider,
  listRequests,
  listRemovalRequests,
  revokeSession,
  saveConfig,
  saveContentPreferences,
  linkFollows,
  unfollowPerformer,
  updateAccount,
  upsertCatalogRecord,
} from "../../../server/storage.ts";
import {
  consumeLoginAttempt,
  guardMutation,
  readSessionToken,
  sessionCookie,
  isSecureRequest,
  verifySetupSecret,
} from "../../../server/security.ts";
import { AppError, validateBaseUrl } from "../../../server/http.ts";
import {
  authenticate,
  getLibraryImage,
  getLibraryItem,
  getServer,
  getUserImage,
  listLibraries,
  listLibraryItems,
  listRecentlyAddedItems,
  listUsers,
  resolvePlaybackAccess,
  validateUser,
  getJellyfinStatus,
} from "../../../server/jellyfin.ts";
import {
  crossProviderLink,
  fetchProviderArtwork,
  getCatalogDetail,
  getProviderStatus,
  isProviderImageUrl,
  listCatalogTags,
  searchCatalog,
  searchCatalogTags,
  studioCounterpart,
  tagCounterpart,
  type CatalogSearchQuery,
  type CatalogSortDirection,
  type CatalogSortKey,
  type ReleaseDateOperation,
} from "../../../server/providers.ts";
import { suggestTags } from "../../../server/judgment.ts";
import {
  findWhisparrItem,
  getWhisparrStatus,
} from "../../../server/whisparr.ts";
import {
  browseTitles,
  isHiddenTitle,
  parseBrowseQuery,
  searchBrowseTags,
  searchVisibleCatalog,
  type BrowsePage,
  type SourceError,
} from "../../../server/browse.ts";
import { relatedPerformers, relatedTitles } from "../../../server/related.ts";

export const BODY_LIMIT_BYTES = 32 * 1024;
export const JELLYFIN_ID =
  /^(?:[0-9a-f]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export async function readJson(
  request: Request,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > BODY_LIMIT_BYTES) {
    throw new AppError(413, "payload_too_large", "Request body exceeds 32KiB.");
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError(
      400,
      "invalid_body",
      "Request body must be a JSON object.",
    );
  }
  return parsed as Record<string, unknown>;
}

export function fieldText(
  body: Record<string, unknown>,
  key: string,
  max: number,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  }
  return value;
}

export function fieldUrl(body: Record<string, unknown>, key: string): string {
  return validateBaseUrl(fieldText(body, key, 2048));
}

export function fieldBool(body: Record<string, unknown>, key: string): boolean {
  if (typeof body[key] !== "boolean")
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  return body[key] as boolean;
}

export function fieldRole(body: Record<string, unknown>, key: string): Role {
  const value = body[key];
  if (value !== "admin" && value !== "moderator" && value !== "requester") {
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  }
  return value;
}

export function fieldIds(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== "string" || !JELLYFIN_ID.test(id))
  ) {
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  }
  return value as string[];
}

export function optionalText(
  body: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  return value;
}

export function requireId(raw: string): string {
  if (!JELLYFIN_ID.test(raw))
    throw new AppError(400, "invalid_id", "Invalid identifier.");
  return raw;
}

export function optionalBool(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  return value;
}

export function queryInt(
  url: URL,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return fallback;
  if (!/^-?\d+$/.test(raw))
    throw new AppError(400, "invalid_query", `Invalid ${key}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new AppError(400, "invalid_query", `Invalid ${key}.`);
  return value;
}

// --- environment-derived status ---

export const PROVIDER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCatalogProvider(raw: string | null): CatalogProvider {
  if (raw === "tpdb" || raw === "stashdb") return raw;
  throw new AppError(400, "invalid_reference", "Unknown catalog provider.");
}
// Two signatures only: the stashdb narrowing one (its call site narrows the
// provider first and needs the narrow return) and the general one.
export function parseCatalogKind(
  provider: "stashdb",
  raw: string,
): "scene" | "performer" | "studio";
export function parseCatalogKind(
  provider: CatalogProvider,
  raw: string,
): CatalogKind;
export function parseCatalogKind(
  provider: CatalogProvider,
  raw: string,
): CatalogKind {
  if (provider === "tpdb") {
    if (
      raw === "movie" ||
      raw === "scene" ||
      raw === "performer" ||
      raw === "studio"
    ) {
      return raw;
    }
    throw new AppError(400, "invalid_reference", "Unknown catalog kind.");
  }
  if (raw === "scene" || raw === "performer" || raw === "studio") return raw;
  throw new AppError(
    400,
    "invalid_reference",
    "StashDB hosts scenes, performers, and studios only.",
  );
}

// External provider identity for catalog routes, validated before any
// upstream call. Ids are canonical provider UUIDs, never the application's
// own catalog record id.
export function parseCatalogReference(
  providerRaw: string,
  kindRaw: string,
  idRaw: string,
): CatalogReference {
  const provider = parseCatalogProvider(providerRaw);
  const kind = parseCatalogKind(provider, kindRaw);
  if (!PROVIDER_UUID.test(idRaw)) {
    throw new AppError(
      400,
      "invalid_reference",
      "Provider catalog ids must be UUIDs.",
    );
  }
  return { provider, kind, id: idRaw.toLowerCase() };
}

// CatalogReference is requestable media only when its kind is movie/scene;
// a performer is catalog-only and must never reach createRequest,
// getAcquisitionByReference, or the availability hints. Runtime check,
// never a cast.
export function isMediaReference(
  reference: CatalogReference,
): reference is MediaReference {
  return reference.kind === "movie" || reference.kind === "scene";
}

export function parseMediaReference(
  providerRaw: string,
  kindRaw: string,
  idRaw: string,
): MediaReference {
  const reference = parseCatalogReference(providerRaw, kindRaw, idRaw);
  if (!isMediaReference(reference)) {
    throw new AppError(
      400,
      "invalid_reference",
      "Performers and studios are not requestable media.",
    );
  }
  return reference;
}

export function sameMedia(a: MediaReference, b: MediaReference): boolean {
  return (
    a.provider === b.provider &&
    a.kind === b.kind &&
    a.id.toLowerCase() === b.id.toLowerCase()
  );
}

// Shared provider-independent scalar validation for catalog search. The
// per-provider builders below explicitly reject filter combinations their
// provider cannot express — never silently ignored downstream.
export interface CatalogSearchParams {
  q: string | null;
  year: number | undefined;
  performer: string | null;
  studio: string | null;
  studioMode: "exact" | "withChildren" | undefined;
  tags: string[] | undefined;
  tagsAll: string[] | undefined;
  tagsExclude: string[] | undefined;
  /** Bounded release-date filter, upstream-native `date` + `date_operation`
   * pair. Null when absent; the pair is always provided together. */
  date: string | null;
  dateOperation: ReleaseDateOperation | null;
  sort: CatalogSortKey | undefined;
  direction: CatalogSortDirection | undefined;
  page: number;
  perPage: number;
}

// Runtime check, never a cast: the vocabulary mirrors providers'
// CatalogSortKey so an unknown sort is the route's explicit 400.
// TPDB date_operation values verified live 2026-09-11: only these operator
// strings; word forms are an upstream 422.
