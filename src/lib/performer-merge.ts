import type {
  CatalogDetail,
  CatalogPerson,
  ExternalLink,
} from "./contracts.ts";

/** Facts a provider edits together: one side supplies the whole group or
 * none of it, so a merge never pairs one provider's band size with the
 * other's waist, or a padded birth date with the other's accuracy. */
const GROUPS: (keyof CatalogPerson)[][] = [
  ["birthDate", "birthDateAccuracy"],
  ["deathDate", "deathDateAccuracy"],
  ["cupSize", "bandSize", "waistIn", "hipIn", "measurementsText"],
  ["careerStartYear", "careerEndYear"],
];

function mergePerson(
  a: CatalogPerson | undefined,
  b: CatalogPerson | undefined,
): CatalogPerson | undefined {
  if (!a || !b) return a ?? b;
  const out: CatalogPerson = { ...b, ...stripUndefined(a) };
  for (const group of GROUPS) {
    const from = group.some((k) => a[k] !== undefined) ? a : b;
    for (const k of group) {
      if (from[k] === undefined) delete out[k];
      else (out as Record<string, unknown>)[k] = from[k];
    }
  }
  // Tattoos and piercings: the longer list wins. TPDB often sends one
  // free-text line ("None", "Lower lip") where stash-box lists each mod
  // with its location, so primacy alone would hide the detail.
  for (const k of ["tattoos", "piercings"] as const) {
    const la = a[k]?.length ?? 0;
    const lb = b[k]?.length ?? 0;
    const pick = lb > la ? b[k] : a[k];
    if (pick === undefined) delete out[k];
    else out[k] = pick;
  }
  return out;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** One link per destination: scheme, "www." and a trailing slash differ
 * between providers for the same page. */
function linkKey(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    return `${host}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
  } catch {
    return url;
  }
}

/**
 * One performer page from two provider records the providers themselves
 * linked (never a name match). `primary` wins every field it has; the
 * other side only fills gaps, so the page reads the same whichever side
 * was opened when the caller passes a fixed order. Aliases and links are
 * unions (deduplicated); the reference stays the primary's.
 */
export function mergePerformerDetails(
  primary: CatalogDetail,
  other: CatalogDetail,
): CatalogDetail {
  const seenAlias = new Set([primary.title.toLowerCase()]);
  const aliases = [...primary.aliases, other.title, ...other.aliases].filter(
    (a) => {
      const k = a.trim().toLowerCase();
      if (k === "" || seenAlias.has(k)) return false;
      seenAlias.add(k);
      return true;
    },
  );
  const seenLink = new Set<string>();
  const links: ExternalLink[] = [...primary.links, ...other.links].filter(
    (l) => {
      const k = linkKey(l.url);
      if (seenLink.has(k)) return false;
      seenLink.add(k);
      return true;
    },
  );
  const person = mergePerson(primary.person, other.person);
  return {
    ...primary,
    description: primary.description || other.description,
    imageUrl: primary.imageUrl ?? other.imageUrl,
    aliases,
    links,
    ...(person ? { person } : {}),
  };
}
