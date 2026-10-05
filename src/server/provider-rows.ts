// Pure TPDB/StashDB row mapping: upstream row objects in, CatalogDetail
// parts out. No I/O, no environment reads, no module state — bad upstream
// data is rejected by returning undefined/empty, never invented. The one
// side channel (TPDB tag numeric-id learning) arrives as an optional
// recordTag callback; the stateful map and its env-derived keys live in
// providers.ts. Upstream shape notes live in providers.ts's header.

import { isLoopbackHost } from "./http.ts";
import type {
  CatalogDetail,
  CatalogPerson,
  CatalogReference,
} from "../lib/contracts.ts";

// --- shared normalizers: reject bad upstream data, never invent values ---

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const parts = v.split("-").map(Number);
  const y = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const d = parts[2] ?? 0;
  const utc = new Date(Date.UTC(y, m - 1, d));
  return (
    utc.getUTCFullYear() === y &&
    utc.getUTCMonth() === m - 1 &&
    utc.getUTCDate() === d
  );
}

export function cleanString(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

export function cleanDuration(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const s = Math.round(v);
  return s >= 1 && s <= 86_400 ? s : undefined; // absurd durations are dropped
}

/** Range-checked integer: upstream stats outside the plausible band are
 * dropped, never normalized into something displayable. */
export function cleanInt(
  v: unknown,
  min: number,
  max: number,
): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max
    ? v
    : undefined;
}

export function cleanYear(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 1900 && v <= 2100
    ? v
    : undefined;
}

export function httpsUrl(v: unknown): string | undefined {
  const s = cleanString(v, 2048);
  if (s === undefined) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password
      ? s
      : undefined;
  } catch {
    return undefined;
  }
}

export const MAX = {
  credits: 50,
  tags: 50,
  aliases: 25,
  mods: 25,
  related: 50,
  links: 30,
  title: 300,
  description: 6000,
  name: 200,
};

export function dedupeBy<T>(
  rows: T[],
  key: (row: T) => string | undefined,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const k = key(row);
    if (k === undefined || seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

// --- artwork gate: provider-hosted images only, pass-through, never persisted ---

// Allowlist derived from live records 2026-09-10: every provider-normalized
// artwork URL observed (TPDB posters/background/image/thumbnail/face, StashDB
// performer images) resolves to one of these hosts. Studio-hosted `image`
// fields (gammacdn, clips4sale, karups, adultempire, ...) are unbounded and
// intentionally excluded, so emitted imageUrl values are always proxyable.
const PROVIDER_IMAGE_HOSTS: Record<string, true> = {
  "cdn.theporndb.net": true,
  "thumb.theporndb.net": true,
  "stashdb.org": true,
};

export type ImageUrlCheck =
  { ok: true; service: "tpdb" | "stashdb" } | { ok: false; reason: string };

/** Pure gate: is this URL a provider-hosted artwork source? Production hosts
 * must be https and on the allowlist above. Loopback plain http is accepted
 * only when the test-only VELVARR_TEST_ARTWORK_ORIGIN opt-in names the URL's
 * exact origin — the test fixtures register themselves there, so production
 * deployments leave every loopback port closed (SSRF hardening v0.36.1). */
export function isProviderImageUrl(url: string): ImageUrlCheck {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "not an absolute URL" };
  }
  const loopbackFixture =
    isLoopbackHost(u.hostname) &&
    (process.env.VELVARR_TEST_ARTWORK_ORIGIN ?? "")
      .split(",")
      .includes(u.origin);
  if (u.protocol !== "https:" && !loopbackFixture) {
    return { ok: false, reason: "artwork URLs must be https" };
  }
  if (u.username || u.password || u.hash) {
    return { ok: false, reason: "artwork URLs must not carry credentials" };
  }
  if (PROVIDER_IMAGE_HOSTS[u.hostname] !== true && !loopbackFixture) {
    return {
      ok: false,
      reason: `host ${u.hostname} is not a provider artwork host`,
    };
  }
  return {
    ok: true,
    service: u.hostname.endsWith("theporndb.net") ? "tpdb" : "stashdb",
  };
}

export function servableImage(v: unknown): string | undefined {
  const s = httpsUrl(v);
  return s !== undefined && isProviderImageUrl(s).ok ? s : undefined;
}

// --- TPDB mapping ---

interface TpdbPerson {
  id?: unknown;
  name?: unknown;
  image?: unknown;
  thumbnail?: unknown;
  face?: unknown;
  parent?: TpdbPerson | null;
}

export interface CatalogCreditAcc {
  reference: CatalogReference;
  name: string;
  imageUrl?: string;
}

/** Credits resolve canonical identity through performers[].parent.id (the
 * canonical performer UUID), falling back to the row id itself. Deduplicated
 * by provider id, never by name. */
export function tpdbCredits(rows: unknown): CatalogCreditAcc[] {
  if (!Array.isArray(rows)) return [];
  const mapped: CatalogCreditAcc[] = [];
  for (const row of rows.slice(0, MAX.credits * 2)) {
    const person = (row ?? {}) as TpdbPerson;
    const canonical = person.parent ?? person;
    const id = isUuid(canonical.id)
      ? canonical.id
      : isUuid(person.id)
        ? person.id
        : undefined;
    const name =
      cleanString(person.name, MAX.name) ??
      cleanString(canonical.name, MAX.name);
    if (id === undefined || name === undefined) continue;
    const imageUrl =
      servableImage(canonical.image) ?? servableImage(person.image);
    mapped.push({
      reference: { provider: "tpdb", kind: "performer", id },
      name,
      ...(imageUrl !== undefined ? { imageUrl } : {}),
    });
  }
  return dedupeBy(mapped, (c) => c.reference.id).slice(0, MAX.credits);
}

export function tpdbTags(
  rows: unknown,
  recordTag?: (uuid: string, numeric: number) => void,
): { id: string; name: string }[] {
  if (!Array.isArray(rows)) return [];
  const out: { id: string; name: string }[] = [];
  for (const row of rows.slice(0, MAX.tags * 2)) {
    const t = (row ?? {}) as { id?: unknown; uuid?: unknown; name?: unknown };
    const name = cleanString(t.name, 120);
    const id = isUuid(t.uuid)
      ? t.uuid
      : isUuid(t.id)
        ? t.id
        : typeof t.id === "number" && Number.isInteger(t.id)
          ? String(t.id)
          : undefined;
    if (id === undefined || name === undefined) continue;
    if (
      isUuid(id) &&
      typeof t.id === "number" &&
      Number.isSafeInteger(t.id) &&
      t.id > 0
    ) {
      recordTag?.(id, t.id);
    }
    out.push({ id, name });
  }
  return dedupeBy(out, (t) => t.id).slice(0, MAX.tags);
}

export function tpdbRelated(
  rows: unknown,
  kind: "movie" | "scene",
): CatalogReference[] {
  if (!Array.isArray(rows)) return [];
  const refs: CatalogReference[] = [];
  for (const row of rows.slice(0, MAX.related * 2)) {
    const id = (row as { id?: unknown } | null)?.id;
    if (isUuid(id)) refs.push({ provider: "tpdb", kind, id });
  }
  return dedupeBy(refs, (r) => r.id).slice(0, MAX.related);
}

export function tpdbMediaDetail(
  kind: "movie" | "scene",
  row: unknown,
  recordTag?: (uuid: string, numeric: number) => void,
): CatalogDetail | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const id = r.id;
  const title = cleanString(r.title, MAX.title);
  if (!isUuid(id) || title === undefined) return undefined;
  const site = r.site as Record<string, unknown> | null | undefined;
  const studioName = cleanString(site?.name, MAX.name);
  const siteUuid = (site as { uuid?: unknown } | null | undefined)?.uuid;
  const description = cleanString(r.description, MAX.description);
  const duration = cleanDuration(r.duration);
  const imageUrl =
    servableImage((r.posters as Record<string, unknown> | null)?.full) ??
    servableImage((r.background as Record<string, unknown> | null)?.large);
  const sourceUrl = httpsUrl(r.url);
  return {
    reference: { provider: "tpdb", kind, id },
    title,
    ...(description !== undefined ? { description } : {}),
    // release date only from `date`; `created`/`last_updated` are record
    // timestamps and deliberately never mapped here.
    ...(isIsoDate(r.date) ? { releaseDate: r.date } : {}),
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(studioName !== undefined
      ? {
          studio: {
            name: studioName,
            ...(isUuid(siteUuid)
              ? {
                  reference: {
                    provider: "tpdb",
                    kind: "studio",
                    id: siteUuid,
                  },
                }
              : {}),
          },
        }
      : {}),
    credits: tpdbCredits(r.performers),
    tags: tpdbTags(r.tags, recordTag),
    // Movies embed their scenes; scenes embed their movies.
    related: tpdbRelated(
      kind === "movie" ? r.scenes : r.movies,
      kind === "movie" ? "scene" : "movie",
    ),
    links:
      sourceUrl !== undefined
        ? [
            {
              url: sourceUrl,
              ...(studioName !== undefined ? { label: studioName } : {}),
            },
          ]
        : [],
    aliases: [],
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
  };
}

export function tpdbPerformerDetail(row: unknown): CatalogDetail | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const id = r.id;
  const name = cleanString(r.name, MAX.name);
  if (!isUuid(id) || name === undefined) return undefined;
  const extras = (r.extras ?? {}) as Record<string, unknown>;
  const links: { url: string; label?: string }[] = [];
  if (extras.links !== null && typeof extras.links === "object") {
    for (const [label, url] of Object.entries(
      extras.links as Record<string, unknown>,
    )) {
      const u = httpsUrl(url);
      if (u === undefined) continue;
      links.push({ url: u, label: cleanString(label, 60) });
      if (links.length >= MAX.links) break;
    }
  }
  const imageUrl =
    servableImage(r.image) ??
    servableImage(r.thumbnail) ??
    servableImage(r.face);
  const aliases = (Array.isArray(r.aliases) ? r.aliases : [])
    .map((a) => cleanString(a, 120))
    .filter((a): a is string => a !== undefined)
    .slice(0, MAX.aliases);
  const bio = cleanString(r.bio, MAX.description);
  return {
    reference: { provider: "tpdb", kind: "performer", id },
    title: name,
    ...(bio !== undefined ? { description: bio } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    credits: [],
    tags: [],
    related: [],
    links,
    aliases,
  };
}

/** TPDB site (studio) rows: {uuid, id (numeric), name, url, description?,
 * logo/poster on cdn.theporndb.net, nested network/parent site rows}. The
 * uuid is the canonical identity; numeric id only as a fallback. The parent
 * relationship is mapped only from provider-supplied parent/network rows —
 * never invented. Favicon is provider-hosted but deliberately not used. */
export function tpdbStudioDetail(row: unknown): CatalogDetail | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const id = isUuid(r.uuid)
    ? r.uuid
    : typeof r.id === "number" && Number.isInteger(r.id)
      ? String(r.id)
      : undefined;
  const name = cleanString(r.name, MAX.name);
  if (id === undefined || name === undefined) return undefined;
  const imageUrl = servableImage(r.poster) ?? servableImage(r.logo);
  const logoUrl = servableImage(r.logo);
  const description = cleanString(r.description, MAX.description);
  const sourceUrl = httpsUrl(r.url);
  const parent = r.parent ?? r.network;
  const parentRow = (parent ?? null) as Record<string, unknown> | null;
  const parentName = cleanString(parentRow?.name, MAX.name);
  const parentId = isUuid(parentRow?.uuid)
    ? parentRow.uuid
    : typeof parentRow?.id === "number" && Number.isInteger(parentRow.id)
      ? String(parentRow.id)
      : undefined;
  return {
    reference: { provider: "tpdb", kind: "studio", id },
    title: name,
    ...(description !== undefined ? { description } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(logoUrl !== undefined ? { logoUrl } : {}),
    ...(parentName !== undefined && parentId !== undefined
      ? {
          studio: {
            name: parentName,
            reference: { provider: "tpdb", kind: "studio", id: parentId },
          },
        }
      : {}),
    credits: [],
    tags: [],
    related: [],
    links: sourceUrl !== undefined ? [{ url: sourceUrl, label: name }] : [],
    aliases: [],
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
  };
}

// --- StashDB mapping ---

interface StashScenePerformer {
  as?: unknown;
  performer?: {
    id?: unknown;
    name?: unknown;
    deleted?: unknown;
    images?: { url?: unknown }[] | null;
  } | null;
}

export function stashImageUrl(images: unknown): string | undefined {
  if (!Array.isArray(images)) return undefined;
  for (const img of images.slice(0, 5)) {
    const url = servableImage((img as { url?: unknown } | null)?.url);
    if (url !== undefined) return url;
  }
  return undefined;
}

export function stashLinks(rows: unknown): { url: string; label?: string }[] {
  if (!Array.isArray(rows)) return [];
  const out: { url: string; label?: string }[] = [];
  for (const row of rows.slice(0, MAX.links * 2)) {
    const r = (row ?? {}) as { url?: unknown; type?: unknown };
    const url = httpsUrl(r.url);
    if (url === undefined) continue;
    out.push({ url, label: cleanString(r.type, 60) });
  }
  return dedupeBy(out, (l) => l.url).slice(0, MAX.links);
}

export function stashCredits(rows: unknown): CatalogCreditAcc[] {
  if (!Array.isArray(rows)) return [];
  const out: CatalogCreditAcc[] = [];
  for (const row of rows.slice(0, MAX.credits * 2)) {
    const entry = (row ?? {}) as StashScenePerformer;
    const p = entry.performer;
    const id = p === null || p === undefined ? undefined : p.id;
    if (!isUuid(id) || p?.deleted === true) continue;
    const name =
      cleanString(entry.as, MAX.name) ?? cleanString(p?.name, MAX.name);
    if (id === undefined || name === undefined) continue;
    const imageUrl = stashImageUrl(p?.images);
    out.push({
      reference: { provider: "stashdb", kind: "performer", id },
      name,
      ...(imageUrl !== undefined ? { imageUrl } : {}),
    });
  }
  return dedupeBy(out, (c) => c.reference.id).slice(0, MAX.credits);
}

export function stashSceneDetail(
  row: unknown,
  recordTag?: (uuid: string, numeric: number) => void,
): CatalogDetail | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const id = r.id;
  const title =
    cleanString(r.title, MAX.title) ?? cleanString(r.code, MAX.title);
  if (!isUuid(id) || title === undefined) return undefined;
  const studio = r.studio as Record<string, unknown> | null | undefined;
  const studioName = cleanString(studio?.name, MAX.name);
  const studioId = studio?.id;
  const details = cleanString(r.details, MAX.description);
  const duration = cleanDuration(r.duration);
  const imageUrl = stashImageUrl(r.images);
  const links = stashLinks(r.urls);
  return {
    reference: { provider: "stashdb", kind: "scene", id },
    title,
    ...(details !== undefined ? { description: details } : {}),
    ...(isIsoDate(r.date) ? { releaseDate: r.date } : {}),
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(studioName !== undefined
      ? {
          studio: {
            name: studioName,
            ...(isUuid(studioId)
              ? {
                  reference: {
                    provider: "stashdb",
                    kind: "studio",
                    id: studioId,
                  },
                }
              : {}),
          },
        }
      : {}),
    credits: stashCredits(r.performers),
    tags: tpdbTags(r.tags, recordTag), // StashDB tags share the TPDB {id, name} shape
    related: [],
    links,
    aliases: [],
  };
}

export function stashPerformerDetail(row: unknown): CatalogDetail | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const id = r.id;
  const name = cleanString(r.name, MAX.name);
  if (!isUuid(id) || name === undefined) return undefined;
  const aliases = (Array.isArray(r.aliases) ? r.aliases : [])
    .map((a) => cleanString(a, 120))
    .filter((a): a is string => a !== undefined)
    .slice(0, MAX.aliases);
  const imageUrl = stashImageUrl(r.images);
  const links = stashLinks(r.urls);
  const person = stashPerformerPerson(r);
  return {
    reference: { provider: "stashdb", kind: "performer", id },
    title: name,
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    credits: [],
    tags: [],
    related: [],
    links,
    aliases,
    ...(person !== undefined ? { person } : {}),
  };
}

/** Biography facts a stash-box Performer row publishes. Only fields present
 * in the row are emitted; an all-empty row maps to no person block at all.
 * `birthdate` (FuzzyDate) is deprecated upstream in favour of `birth_date`,
 * but it is the field every shipped stash-box release resolves — switch once
 * prod is guaranteed to run a release that knows `birth_date`. */
export function stashPerformerPerson(
  r: Record<string, unknown>,
): CatalogPerson | undefined {
  const birth = stashFuzzyDate(r.birthdate);
  const person: CatalogPerson = {
    gender: stashEnumLabel(r.gender),
    ...(birth !== undefined
      ? { birthDate: birth.date, birthDateAccuracy: birth.accuracy }
      : {}),
    country: cleanString(r.country, 80),
    ethnicity: stashEnumLabel(r.ethnicity),
    eyeColor: stashEnumLabel(r.eye_color),
    hairColor: stashEnumLabel(r.hair_color),
    heightCm: cleanInt(r.height, 50, 280),
    cupSize: cleanString(r.cup_size, 10),
    // Inches, not cm: stash-box stores band/waist/hip in inches and its
    // PerformerForm validates band 28-56 and waist 15-50. Hip has no
    // upstream range; 10-100 in is a loose sanity cap.
    bandSize: cleanInt(r.band_size, 28, 56),
    waistIn: cleanInt(r.waist_size, 15, 50),
    hipIn: cleanInt(r.hip_size, 10, 100),
    breastType: stashEnumLabel(r.breast_type),
    careerStartYear: cleanYear(r.career_start_year),
    careerEndYear: cleanYear(r.career_end_year),
    tattoos: stashBodyMods(r.tattoos),
    piercings: stashBodyMods(r.piercings),
  };
  const entries = Object.entries(person).filter(([, v]) => v !== undefined);
  return entries.length > 0
    ? (Object.fromEntries(entries) as CatalogPerson)
    : undefined;
}

/** Humanises a stash-box enum value ("TRANSGENDER_FEMALE" becomes
 * "Transgender female"). NA means "not applicable" — dropped, never shown. */
export function stashEnumLabel(v: unknown): string | undefined {
  if (typeof v !== "string" || v === "NA") return undefined;
  const s = v.toLowerCase().replaceAll("_", " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** stash-box FuzzyDate: accuracy names the parts the provider vouches for
 * (unknown day/month arrive padded). An unknown accuracy maps to absent. */
export function stashFuzzyDate(
  v: unknown,
): { date: string; accuracy: "day" | "month" | "year" } | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const r = v as { date?: unknown; accuracy?: unknown };
  if (!isIsoDate(r.date)) return undefined;
  if (r.accuracy !== "DAY" && r.accuracy !== "MONTH" && r.accuracy !== "YEAR") {
    return undefined;
  }
  return {
    date: r.date,
    accuracy: r.accuracy.toLowerCase() as "day" | "month" | "year",
  };
}

/** Body modifications: "Left wrist: script A" or bare "Left wrist". */
export function stashBodyMods(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const mods = v
    .map((m) => {
      if (m === null || typeof m !== "object") return undefined;
      const r = m as { location?: unknown; description?: unknown };
      const location = cleanString(r.location, 120);
      if (location === undefined) return undefined;
      const description = cleanString(r.description, 120);
      return description !== undefined
        ? `${location}: ${description}`
        : location;
    })
    .filter((m): m is string => m !== undefined)
    .slice(0, MAX.mods);
  return mods.length > 0 ? mods : undefined;
}

/** StashDB Studio: {id, name, deleted, urls, images, parent, child_studios}.
 * Deleted rows are unusable everywhere (authoritative absence), so they never
 * map; the parent studio is mapped only when the provider supplies one. */
export function stashStudioDetail(
  row: unknown,
): (CatalogDetail & { childStudioCount?: number }) | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const id = r.id;
  const name = cleanString(r.name, MAX.name);
  if (!isUuid(id) || name === undefined) return undefined;
  if (r.deleted === true) return undefined;
  const parent = r.parent as Record<string, unknown> | null | undefined;
  const parentName = cleanString(parent?.name, MAX.name);
  const parentId = parent?.id;
  const imageUrl = stashImageUrl(r.images);
  const links = stashLinks(r.urls);
  // Provider-supplied structural hint only: an absent child_studios field
  // stays absent (unknown), a supplied empty list is a real zero. Never
  // invented for providers that do not expose one.
  const childStudioCount = Array.isArray(r.child_studios)
    ? r.child_studios.filter((c) => {
        if (c === null || typeof c !== "object" || !("id" in c)) return false;
        return isUuid(c.id);
      }).length
    : undefined;
  return {
    reference: { provider: "stashdb", kind: "studio", id },
    title: name,
    // StashDB publishes one studio image and it is the brand mark itself.
    ...(imageUrl !== undefined ? { imageUrl, logoUrl: imageUrl } : {}),
    ...(parentName !== undefined && isUuid(parentId)
      ? {
          studio: {
            name: parentName,
            reference: { provider: "stashdb", kind: "studio", id: parentId },
          },
        }
      : {}),
    ...(childStudioCount !== undefined ? { childStudioCount } : {}),
    credits: [],
    tags: [],
    related: [],
    links,
    aliases: [],
  };
}
