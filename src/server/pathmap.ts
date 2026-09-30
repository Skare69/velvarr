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
