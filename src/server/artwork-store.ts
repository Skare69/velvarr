// On-disk store for resized provider-artwork variants (VELV-170). Variants
// are content-addressed by the sha256 of the source bytes:
// <dataDir>/artwork/<hash[0:2]>/<hash>-<width>c.webp. Originals stay
// memory-only in providers.ts; only regenerable derivatives are persisted,
// per operator approval (VELV-169, 2026-11-15). This module must stay
// SQLite-free for the image path, so it never imports storage.ts and reads
// the data dir from the environment at call time instead.

import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ARTWORK_VARIANT } from "../lib/contracts.ts";
import sharp from "sharp";

export const ARTWORK_WIDTHS = [200, 400, 600] as const;
export type ArtworkWidth = (typeof ARTWORK_WIDTHS)[number];

export function isArtworkWidth(value: unknown): value is ArtworkWidth {
  return (ARTWORK_WIDTHS as readonly unknown[]).includes(value);
}

export interface ArtworkVariantResult {
  bytes: Uint8Array;
  contentType: string;
  hash: string; // lowercase hex sha256 of the SOURCE bytes
  /** True only when bytes are the stored/generated WebP variant; false on
   * no-upscale passthrough or degrade, where bytes are the untouched source
   * and contentType is the source's. */
  isVariant: boolean;
}

// Variants are regenerable derivatives, so the store is a bounded cache, not
// an archive: 512 MiB of disk, entries dropped after 30 idle days.
const ARTWORK_STORE_BUDGET_BYTES = 512 * 1024 * 1024;
const ARTWORK_STORE_TTL_MS = 30 * 24 * 60 * 60_000;
// The url → hash index is only a shortcut within the same staleness window
// the source memory cache already has (24 h): after it expires the next
// width request re-fetches the source, re-hashes, and rewrites the entry,
// so a provider image change can never serve stale longer than today's
// memory cache would.
const ARTWORK_INDEX_TTL_MS = 24 * 60 * 60_000;

// Count allocation with a 4 KiB floor, including small URL index entries.
const MIN_FILE_DISK_BYTES = 4096;

function countedFileBytes(st: { size: number; blocks: number }): number {
  return Math.max(MIN_FILE_DISK_BYTES, st.size, st.blocks * 512);
}

// Set (and un-set with null) by tests only; it survives for the process
// lifetime because a restart keeps the disk and the store has no other
// module state to clear.
let testBudgetOverride: number | null = null;

// Read at call time (same pattern as storage.ts's open()) so a save or an
// environment change takes effect without a restart.
function artworkRootDir(): string {
  return path.join(process.env.VELVARR_DATA_DIR || "./data", "artwork");
}

// Cards crop with object-fit: cover into frames from 2:3 portrait to wide, so
// a w variant must cover a w × 1.5w box: a 16:9 scene still at w=200 needs
// 300 px of height, not the 113 px a plain width resize gives (VELV-170
// tiles went blurry). The "c" suffix retires the old width-only files; they
// age out by the store TTL.
const COVER_HEIGHT_RATIO = 1.5;

function variantPath(hash: string, width: ArtworkWidth): string {
  return path.join(
    artworkRootDir(),
    hash.slice(0, 2),
    `${hash}-${width}${ARTWORK_VARIANT}.webp`,
  );
}

/** Best-effort read of a fresh non-empty variant; null means "miss". */
function readVariantIfFresh(file: string): Uint8Array | null {
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  // Never serve zero bytes: a truncated or crashed write is deleted on sight
  // and treated as a miss.
  if (st.size === 0) {
    try {
      unlinkSync(file);
    } catch {
      // A racing sweep or reset already removed it.
    }
    return null;
  }
  if (Date.now() - st.mtimeMs >= ARTWORK_STORE_TTL_MS) return null;
  // LRU touch: mtime recency drives both the TTL and the budget eviction.
  utimesSync(file, new Date(), new Date());
  return readFileSync(file);
}

/** Corrupt/unsupported source or unusable output: never fabricate image
 * bytes — hand back the source unchanged, write nothing, and leave a named
 * line in the log so degraded artwork is diagnosable. */
function passthroughDegrade(
  source: { bytes: Uint8Array; contentType: string },
  hash: string,
  width: ArtworkWidth,
  reason: unknown,
): ArtworkVariantResult {
  console.error(
    `artwork-store: sharp could not read ${hash} (w=${width}): ${
      reason instanceof Error ? reason.message : String(reason)
    }`,
  );
  return {
    bytes: source.bytes,
    contentType: source.contentType,
    hash,
    isVariant: false,
  };
}

/** Atomic write: temp file in the target's own directory, then rename, so a
 * crash can never leave a partial file under the final name. */
function writeFileAtomic(file: string, bytes: Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file never landed or was already removed.
    }
    throw err;
  }
}

/** Drop expired and empty files after each write, then evict by oldest mtime.
 * Keep the newest file even when it alone exceeds the budget. */
function sweepArtworkStore(justWritten: string): void {
  const root = artworkRootDir();
  let walked: string[];
  try {
    walked = readdirSync(root, { recursive: true, encoding: "utf8" });
  } catch (err) {
    console.error(
      `artwork-store: sweep could not read ${root}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  // ponytail: full directory walk per write; a persistent LRU index is the
  // upgrade if the tree ever grows enough for the walk to show up.
  const now = Date.now();
  let total = 0;
  const kept: { file: string; mtimeMs: number; size: number }[] = [];
  for (const rel of walked) {
    const file = path.join(root, rel);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue; // Vanished mid-sweep; nothing to reclaim.
    }
    if (!st.isFile()) continue;
    // Index entries are shortcuts living by the index TTL; the variants
    // themselves live by the store TTL. Both count toward the budget.
    // readdirSync returns native separators: "index\<hash>" on Windows.
    const ttl = rel.startsWith(`index${path.sep}`)
      ? ARTWORK_INDEX_TTL_MS
      : ARTWORK_STORE_TTL_MS;
    if (st.size === 0 || now - st.mtimeMs >= ttl) {
      try {
        unlinkSync(file);
      } catch {
        continue; // Already gone.
      }
      continue;
    }
    const diskBytes = countedFileBytes(st);
    total += diskBytes;
    kept.push({ file, mtimeMs: st.mtimeMs, size: diskBytes });
  }
  // Oldest first: budget pressure always evicts the least recently used.
  kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
  while (total > (testBudgetOverride ?? ARTWORK_STORE_BUDGET_BYTES)) {
    const idx = kept.findIndex((entry) => entry.file !== justWritten);
    if (idx === -1) break; // Only the fresh file remains; it stays.
    const victim = kept.splice(idx, 1)[0];
    if (victim === undefined) break;
    total -= victim.size;
    try {
      unlinkSync(victim.file);
    } catch {
      // Already gone; its bytes no longer count either way.
    }
  }
}

// url → hash index: the restart shortcut for the width path. A width request
// must hash the source bytes to name its variant file, and those bytes are
// memory-only, so the index remembers the hash per URL on disk; with it, a
// restart serves stored variants without re-fetching the source (VELV-168
// design §4.5). It is an optimization, never a correctness dependency: any
// miss or read failure degrades to re-fetching the source.

function artworkIndexDir(): string {
  return path.join(artworkRootDir(), "index");
}

function indexFilePath(url: string): string {
  return path.join(
    artworkIndexDir(),
    createHash("sha256").update(url).digest("hex"),
  );
}

/** Fresh, non-empty, well-formed index entry → the source hash it names.
 * Only a lowercase hex sha256 is accepted: the content becomes part of the
 * variant path, so it must never smuggle path syntax. Zero-byte entries are
 * deleted on sight. */
function readIndexHash(url: string): string | null {
  const file = indexFilePath(url);
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  if (st.size === 0) {
    try {
      unlinkSync(file);
    } catch {
      // A racing sweep already removed it.
    }
    return null;
  }
  if (Date.now() - st.mtimeMs >= ARTWORK_INDEX_TTL_MS) return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

/** Disk shortcut for the width path: resolves url → hash via the index, then
 * the variant file. Touches both mtimes on hit (LRU). Any miss — missing,
 * expired, zero-byte, fs error — is null; it never throws. */
export function lookupArtworkVariant(
  url: string,
  width: ArtworkWidth,
): {
  bytes: Uint8Array;
  contentType: string;
  hash: string;
  isVariant: boolean;
} | null {
  const hash = readIndexHash(url);
  if (hash === null) return null;
  const hit = readVariantIfFresh(variantPath(hash, width));
  if (hit === null) return null;
  // Keep the index entry as fresh as the variant it points at.
  try {
    utimesSync(indexFilePath(url), new Date(), new Date());
  } catch {
    // The variant hit stands even if the touch fails.
  }
  return { bytes: hit, contentType: "image/webp", hash, isVariant: true };
}

/** Remember url → hash so a restart can serve variants without re-fetching
 * the source. Best-effort atomic write; a failure logs and degrades to a
 * refetch on the next width request. */
export function rememberArtworkVariant(url: string, hash: string): void {
  if (hash.length === 0) return;
  // Passthroughs return here on every memory hit. An unchanged fresh index
  // needs neither a rewrite nor an uncharged full-tree sweep.
  if (readIndexHash(url) === hash) return;
  try {
    const file = indexFilePath(url);
    writeFileAtomic(file, Buffer.from(hash, "utf8"));
    // New or refreshed entries still need budget and expiry enforcement.
    sweepArtworkStore(file);
  } catch (err) {
    console.error(
      `artwork-store: could not write artwork index entry: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Return the WebP variant of `source` at `width`, reading it from the disk
 * store when present, generating and storing it otherwise. Sources too small
 * to downscale (measured on the EXIF-oriented axis) and sources sharp cannot
 * read come back unchanged (no file, source contentType); a stored variant
 * always comes back as image/webp and upright: WebP output drops the EXIF
 * orientation tag, so the pixels are pre-rotated at generation time. */
export async function artworkVariantFor(
  source: { bytes: Uint8Array; contentType: string },
  width: ArtworkWidth,
): Promise<ArtworkVariantResult> {
  const hash = createHash("sha256").update(source.bytes).digest("hex");
  const file = variantPath(hash, width);
  const hit = readVariantIfFresh(file);
  if (hit !== null) {
    return { bytes: hit, contentType: "image/webp", hash, isVariant: true };
  }

  let meta;
  try {
    meta = await sharp(source.bytes).metadata();
  } catch (err) {
    return passthroughDegrade(source, hash, width, err);
  }
  // Never upscale: when either oriented axis is already at or below the
  // cover box, no downscale keeps the cover, so the source is the answer.
  // Rotated sources count on the oriented axes (EXIF 6 stores an upright
  // portrait as landscape pixels), else the upright image gets upscaled.
  const orientedWidth = meta.autoOrient?.width ?? meta.width;
  const orientedHeight = meta.autoOrient?.height ?? meta.height;
  const height = Math.round(width * COVER_HEIGHT_RATIO);
  if (
    (orientedWidth !== undefined && orientedWidth <= width) ||
    (orientedHeight !== undefined && orientedHeight <= height)
  ) {
    return {
      bytes: source.bytes,
      contentType: source.contentType,
      hash,
      isVariant: false,
    };
  }

  let variant: Buffer;
  try {
    variant = await sharp(source.bytes)
      .autoOrient()
      .resize({ width, height, fit: "outside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch (err) {
    return passthroughDegrade(source, hash, width, err);
  }
  if (variant.length === 0) {
    return passthroughDegrade(source, hash, width, "sharp wrote zero bytes");
  }

  writeFileAtomic(file, variant);
  sweepArtworkStore(file);
  return { bytes: variant, contentType: "image/webp", hash, isVariant: true };
}

/** Test seam: walks the store tree for the current file count and bytes. */
export function artworkStoreStateForTest(): {
  files: number;
  bytes: number;
  budget: number;
} {
  let files = 0;
  let bytes = 0;
  let walked: string[];
  try {
    walked = readdirSync(artworkRootDir(), {
      recursive: true,
      encoding: "utf8",
    });
  } catch {
    return {
      files,
      bytes,
      budget: testBudgetOverride ?? ARTWORK_STORE_BUDGET_BYTES,
    };
  }
  for (const rel of walked) {
    let st;
    try {
      st = statSync(path.join(artworkRootDir(), rel));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    files += 1;
    bytes += countedFileBytes(st);
  }
  return {
    files,
    bytes,
    budget: testBudgetOverride ?? ARTWORK_STORE_BUDGET_BYTES,
  };
}

/** Test seam: caps (or, with null, un-caps) the store budget for the rest of
 * the process. */
export function setArtworkStoreBudgetForTest(maxBytes: number | null): void {
  testBudgetOverride = maxBytes;
}
