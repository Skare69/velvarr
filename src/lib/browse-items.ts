import type { CatalogDetail } from "./contracts.ts";

/** Key an item by its provider identity — the same key the browse grid uses
 * for React, so a card can never render twice. */
function itemKey(it: CatalogDetail): string {
  return `${it.reference.provider}:${it.reference.id}`;
}

/** Appends one fetched page to the accumulated browse grid: keeps order,
 * drops items already present (across pages and within the incoming page
 * itself). Providers reorder between fetches — trending, newly added — so a
 * naive concat would show the same card twice. */
export function mergePageItems(
  existing: CatalogDetail[],
  incoming: CatalogDetail[],
): CatalogDetail[] {
  const seen = new Set(existing.map(itemKey));
  return [
    ...existing,
    ...incoming.filter((it) => {
      const key = itemKey(it);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}
