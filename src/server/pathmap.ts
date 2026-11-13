// Shared Whisparr↔Jellyfin path mapping. Pure path logic used by the
// Jellyfin adapter (playback access) and the Whisparr adapter (identity
// lookup by path); it lives here so neither adapter imports the other.

import type { WhisparrPathMapping } from "../lib/contracts.ts";

export function pathComponents(path: string): string[] {
  return path.split(/[\\/]+/).filter((c) => c.length > 0);
}

export function looksWindows(path: string): boolean {
  return path.includes("\\") || /^[a-zA-Z]:[\\/]/.test(path);
}

// Full-component prefix test. Never a loose substring: components must line
// up exactly, with case folding only for Windows-style paths.
export function samePathPrefix(
  prefix: string[],
  full: string[],
  fold: boolean,
): boolean {
  if (full.length < prefix.length) return false;
  return prefix.every((part, i) =>
    fold
      ? part.toLowerCase() === (full[i] ?? "").toLowerCase()
      : part === full[i],
  );
}

// Maps a Whisparr path through the first matching configured mapping and
// returns comparable components plus the case-fold decision. With no
// matching mapping the path is compared as-is (shared-mount deployments).
export function mappedPrefix(
  whisparrPath: string,
  mappings: WhisparrPathMapping[] | undefined,
): { comps: string[]; fold: boolean } {
  const pathComps = pathComponents(whisparrPath);
  for (const mapping of mappings ?? []) {
    const prefixComps = pathComponents(mapping.whisparrPrefix);
    const fold =
      looksWindows(whisparrPath) ||
      looksWindows(mapping.whisparrPrefix) ||
      looksWindows(mapping.jellyfinPrefix);
    if (
      prefixComps.length > 0 &&
      samePathPrefix(prefixComps, pathComps, fold)
    ) {
      return {
        comps: [
          ...pathComponents(mapping.jellyfinPrefix),
          ...pathComps.slice(prefixComps.length),
        ],
        fold,
      };
    }
  }
  return { comps: pathComps, fold: looksWindows(whisparrPath) };
}

/** Paths indexed by their case-folded components, so one lookup per prefix
 * of a queried path replaces a samePathPrefix pass over every entry. */
export type PrefixIndex<T> = Map<
  string,
  { exact: string; fold: boolean; seq: number; value: T }[]
>;

export function buildPrefixIndex<T>(
  entries: { comps: string[]; fold: boolean; value: T }[],
): PrefixIndex<T> {
  const index: PrefixIndex<T> = new Map();
  entries.forEach(({ comps, fold, value }, seq) => {
    // Components never hold a separator, so "/"-joined keys are unambiguous.
    const key = comps.map((c) => c.toLowerCase()).join("/");
    const bucket = index.get(key) ?? [];
    bucket.push({ exact: comps.join("/"), fold, seq, value });
    index.set(key, bucket);
  });
  return index;
}

/** The values whose components are a prefix of any of `paths` under
 * samePathPrefix (folding when the entry or the path is Windows-style),
 * each once, in entry order. */
export function prefixMatches<T>(index: PrefixIndex<T>, paths: string[]): T[] {
  const hits = new Map<number, T>();
  for (const path of paths) {
    const comps = pathComponents(path);
    const lower = comps.map((c) => c.toLowerCase());
    const fold = looksWindows(path);
    for (let length = 0; length <= comps.length; length += 1) {
      const bucket = index.get(lower.slice(0, length).join("/"));
      if (bucket === undefined) continue;
      const exact = comps.slice(0, length).join("/");
      for (const entry of bucket) {
        if (fold || entry.fold || entry.exact === exact) {
          hits.set(entry.seq, entry.value);
        }
      }
    }
  }
  return [...hits].sort(([a], [b]) => a - b).map(([, value]) => value);
}
