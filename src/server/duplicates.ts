import sharp from "sharp";
import type {
  CatalogDetail,
  CatalogTagSelection,
  DuplicateMovieMatch,
  DuplicateMoviesResponse,
  SourceError,
} from "../lib/contracts.ts";
import { hiddenTitleMatcher } from "./catalog-visibility.ts";
import { AppError, sourceError, upstreamCheckError } from "./http.ts";
import {
  isProviderImageUrl,
  isUuid,
  tpdbMediaDetail,
} from "./provider-rows.ts";
import { fetchProviderArtwork, tpdbGet } from "./providers.ts";

type MovieHash = { type: "OSHASH" | "PHASH"; hash: string };
export type DuplicateInput = {
  detail: CatalogDetail;
  hashes: MovieHash[];
  performerNumber?: number;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function badResponse(): AppError {
  return new AppError(
    502,
    "upstream_bad_response",
    "TPDB returned an invalid duplicate-check record.",
  );
}

export function parseDuplicateMovie(value: unknown): DuplicateInput {
  const row = record(value);
  const detail = tpdbMediaDetail("movie", value);
  if (!row || !detail) throw badResponse();
  for (const field of ["hashes", "performers", "tags"]) {
    if (row[field] != null && !Array.isArray(row[field])) throw badResponse();
  }
  const hashes = new Map<string, MovieHash>();
  for (const raw of (row.hashes ?? []) as unknown[]) {
    const h = record(raw);
    if (
      !h ||
      (h.type !== "OSHASH" && h.type !== "PHASH") ||
      typeof h.hash !== "string" ||
      !/^[a-f0-9]{16}$/i.test(h.hash)
    ) {
      throw badResponse();
    }
    const hash = h.hash.toLowerCase();
    hashes.set(`${h.type}:${hash}`, { type: h.type, hash });
  }
  const credits = new Set(
    detail.credits.map((c) => c.reference.id.toLowerCase()),
  );
  let performerNumber: number | undefined;
  for (const raw of (row.performers ?? []) as unknown[]) {
    const parent = record(record(raw)?.parent);
    if (
      isUuid(parent?.id) &&
      credits.has(parent.id.toLowerCase()) &&
      typeof parent._id === "number" &&
      Number.isSafeInteger(parent._id) &&
      parent._id > 0
    ) {
      performerNumber = parent._id;
      break;
    }
  }
  return { detail, hashes: [...hashes.values()], performerNumber };
}

/** Cheap metadata gates run before any image fetch. Sets make the rule symmetric. */
export function duplicateMetadata(
  a: CatalogDetail,
  b: CatalogDetail,
):
  | {
      sharedPerformerIds: string[];
      tagOverlap: number;
    }
  | undefined {
  if (a.reference.id.toLowerCase() === b.reference.id.toLowerCase())
    return undefined;
  if (
    !a.releaseDate ||
    !b.releaseDate ||
    a.releaseDate.slice(0, 4) !== b.releaseDate.slice(0, 4)
  )
    return undefined;
  const ap = new Set(a.credits.map((c) => c.reference.id.toLowerCase()));
  const bp = new Set(b.credits.map((c) => c.reference.id.toLowerCase()));
  const sharedPerformerIds = [...ap].filter((id) => bp.has(id)).sort();
  if (
    !ap.size ||
    !bp.size ||
    sharedPerformerIds.length !== Math.min(ap.size, bp.size)
  )
    return undefined;
  const at = new Set(a.tags.map((t) => t.id.toLowerCase()));
  const bt = new Set(b.tags.map((t) => t.id.toLowerCase()));
  if (!at.size || !bt.size) return undefined;
  const tagOverlap =
    [...at].filter((id) => bt.has(id)).length / Math.min(at.size, bt.size);
  if (tagOverlap < 0.5) return undefined;
  const ad = a.durationSeconds;
  const bd = b.durationSeconds;
  if (
    ad !== undefined &&
    bd !== undefined &&
    Math.abs(ad - bd) * 10 > Math.max(ad, bd)
  )
    return undefined;
  return { sharedPerformerIds, tagOverlap };
}

export async function posterDhash(bytes: Uint8Array): Promise<bigint> {
  let pixels: Buffer;
  try {
    pixels = await sharp(bytes, {
      limitInputPixels: 40_000_000,
      failOn: "error",
    })
      .autoOrient()
      .removeAlpha()
      .greyscale()
      .resize(9, 8, { fit: "fill" })
      .raw()
      .timeout({ seconds: 5 })
      .toBuffer();
  } catch {
    // Decoder messages can contain upstream data. Expose only the failure class.
    throw new AppError(
      502,
      "upstream_bad_response",
      "TPDB image could not be decoded for the duplicate check.",
    );
  }
  let bits = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      bits =
        (bits << 1n) | (pixels[y * 9 + x]! > pixels[y * 9 + x + 1]! ? 1n : 0n);
    }
  }
  return bits;
}

export function posterDistance(a: bigint, b: bigint): number {
  let bits = BigInt.asUintN(64, a ^ b);
  let distance = 0;
  while (bits) {
    bits &= bits - 1n;
    distance += 1;
  }
  return distance;
}

function expectedError(error: unknown): SourceError {
  if (error instanceof AppError && error.code === "provider_not_configured")
    return sourceError("tpdb", error);
  return { provider: "tpdb", ...upstreamCheckError(error) };
}

async function imageHash(url: string): Promise<bigint> {
  const check = isProviderImageUrl(url);
  // The shared artwork gate already refuses off-allowlist hosts and explicit
  // ports (VELV-216). stashdb.org is refused here because the duplicate check
  // never hashes StashDB artwork, even though the gate serves /images/.
  if (!check.ok || new URL(url).hostname === "stashdb.org") {
    throw new AppError(
      502,
      "upstream_bad_response",
      "TPDB image URL is not allowed for the duplicate check.",
    );
  }
  const { bytes } = await fetchProviderArtwork(url);
  return posterDhash(bytes);
}

/** One metadata page and up to five hash pages; no catalog crawl or durable pairs. */
export async function duplicateMovies(
  id: string,
  hiddenTags: CatalogTagSelection[],
): Promise<DuplicateMoviesResponse> {
  if (!isUuid(id))
    throw new AppError(
      400,
      "invalid_reference",
      "Provider catalog ids must be UUIDs.",
    );
  const result: DuplicateMoviesResponse = {
    selfUrl: `https://theporndb.net/movies/${id.toLowerCase()}`,
    matches: [],
    incomplete: [],
    errors: [],
  };
  let source: DuplicateInput;
  try {
    const body = await tpdbGet<unknown>(`/movies/${id}`);
    source = parseDuplicateMovie(record(body)?.data);
    if (source.detail.reference.id.toLowerCase() !== id.toLowerCase())
      throw badResponse();
  } catch (error) {
    if (error instanceof AppError && error.upstreamStatus === 404) {
      throw new AppError(
        404,
        "catalog_not_found",
        "This movie is not in the TPDB catalog.",
      );
    }
    result.errors.push(expectedError(error));
    return result;
  }
  const queries: { label: string; params: URLSearchParams }[] = [];
  const year = source.detail.releaseDate?.slice(0, 4);
  if (!year) result.incomplete.push("Metadata check skipped: no release date");
  if (source.performerNumber === undefined)
    result.incomplete.push(
      "Metadata check skipped: no performer with a TPDB id",
    );
  if (year && source.performerNumber !== undefined) {
    queries.push({
      label: "Metadata candidates",
      params: new URLSearchParams({
        performer_id: String(source.performerNumber),
        year,
        per_page: "100",
      }),
    });
  }
  if (source.hashes.length > 5)
    result.incomplete.push(`checked 5 of ${source.hashes.length} hashes`);
  for (const h of source.hashes.slice(0, 5)) {
    queries.push({
      label: `${h.type} candidates`,
      params: new URLSearchParams({
        hash: h.hash,
        hash_type: h.type,
        per_page: "100",
      }),
    });
  }
  const hidden = hiddenTitleMatcher(hiddenTags);
  const pages = await Promise.all(
    queries.map(async ({ label, params }) => {
      try {
        const body = record(await tpdbGet<unknown>(`/movies?${params}`));
        if (!body || !Array.isArray(body.data)) throw badResponse();
        return { label, body, error: undefined };
      } catch (error) {
        return { label, body: undefined, error: expectedError(error) };
      }
    }),
  );
  const candidates = new Map<string, DuplicateInput>();
  for (const page of pages) {
    if (!page.body) {
      result.errors.push({
        ...page.error!,
        message: `${page.label}: ${page.error!.message}`,
      });
      continue;
    }
    const rows = page.body.data as unknown[];
    if (
      rows.length > 100 ||
      record(page.body.links)?.next ||
      record(page.body.meta)?.next_page_url
    ) {
      result.incomplete.push(
        `${page.label}: only the first 100 candidates were checked`,
      );
    }
    for (const row of rows.slice(0, 100)) {
      // Filter visibility before parsing optional evidence or producing row-specific errors.
      const detail = tpdbMediaDetail("movie", row);
      if (
        detail &&
        (detail.reference.id.toLowerCase() === id.toLowerCase() ||
          hidden(detail))
      )
        continue;
      try {
        const movie = parseDuplicateMovie(row);
        const key = movie.detail.reference.id.toLowerCase();
        const existing = candidates.get(key);
        if (!existing) candidates.set(key, movie);
        else {
          for (const h of movie.hashes) {
            if (
              !existing.hashes.some(
                (other) => other.type === h.type && other.hash === h.hash,
              )
            ) {
              existing.hashes.push(h);
            }
          }
        }
      } catch (error) {
        result.errors.push(expectedError(error));
      }
    }
  }
  const matches = new Map<string, DuplicateMovieMatch>();
  function match(movie: DuplicateInput): DuplicateMovieMatch {
    const d = movie.detail;
    const key = d.reference.id.toLowerCase();
    let item = matches.get(key);
    if (!item) {
      item = {
        reference: d.reference,
        title: d.title,
        releaseDate: d.releaseDate,
        durationSeconds: d.durationSeconds,
        studio: d.studio?.name,
        tpdbUrl: `https://theporndb.net/movies/${key}`,
        rules: [],
        evidence: {},
      };
      matches.set(key, item);
    }
    return item;
  }
  const sourceHashes = new Set(source.hashes.map((h) => `${h.type}:${h.hash}`));
  const metadata = [];
  for (const movie of candidates.values()) {
    const sharedHashes = movie.hashes.filter((h) =>
      sourceHashes.has(`${h.type}:${h.hash}`),
    );
    if (sharedHashes.length) {
      const item = match(movie);
      item.rules.push("hash");
      item.evidence.sharedHashes = sharedHashes;
    }
    const evidence = duplicateMetadata(source.detail, movie.detail);
    if (evidence) metadata.push({ movie, evidence });
  }
  metadata.sort(
    (a, b) =>
      b.evidence.sharedPerformerIds.length -
        a.evidence.sharedPerformerIds.length ||
      b.evidence.tagOverlap - a.evidence.tagOverlap ||
      a.movie.detail.reference.id
        .toLowerCase()
        .localeCompare(b.movie.detail.reference.id.toLowerCase()),
  );
  let postersCompared = 0;
  if (metadata.length) {
    let sourceHash: bigint | undefined;
    if (source.detail.imageUrl) {
      try {
        sourceHash = await imageHash(source.detail.imageUrl);
      } catch (error) {
        const failure = expectedError(error);
        result.errors.push({
          ...failure,
          message: `TPDB image for the current movie: ${failure.message}`,
        });
      }
    }
    if (sourceHash === undefined) {
      result.incomplete.push("Duplicate check incomplete: poster unavailable");
    } else {
      for (const { movie, evidence } of metadata.slice(0, 10)) {
        const d = movie.detail;
        if (!d.imageUrl) {
          result.incomplete.push(
            `no poster to compare for ${d.title} (${d.reference.id})`,
          );
          continue;
        }
        try {
          const distance = posterDistance(
            sourceHash,
            await imageHash(d.imageUrl),
          );
          postersCompared += 1;
          if (distance <= 10) {
            const item = match(movie);
            item.rules.push("metadata");
            Object.assign(item.evidence, evidence, {
              posterDistance: distance,
            });
          }
        } catch (error) {
          const failure = expectedError(error);
          result.errors.push({
            ...failure,
            message: `TPDB image for ${d.title} (${d.reference.id}): ${failure.message}`,
          });
        }
      }
    }
  }
  if (metadata.length > 10)
    result.incomplete.push(
      `posters compared for ${postersCompared} of ${metadata.length} candidates`,
    );
  result.matches = [...matches.values()];
  result.incomplete = [...new Set(result.incomplete)];
  result.errors = result.errors.filter(
    (error, i, all) =>
      all.findIndex(
        (other) => other.code === error.code && other.message === error.message,
      ) === i,
  );
  return result;
}
