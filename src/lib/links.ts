import type { ExternalLink } from "./contracts.ts";

/** "www.elegantangel.com" -> "elegantangel.com"; null for a bad URL. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** "onlyfans.com/jewelzblu": the host plus the first path segment. */
function handleOf(url: string): string | null {
  const host = hostOf(url);
  if (host === null) return null;
  const first = new URL(url).pathname.split("/").find((s) => s !== "");
  return first ? `${host}/${decodeURIComponent(first)}` : host;
}

/**
 * The visible text of a performer link chip. A generic label ("Studio
 * profile") says nothing a reader can tell apart, so the chip shows the
 * site. Two links under one label ("OnlyFans" twice: a free and a paid
 * account) show what differs - the site, or the account when the site is
 * the same. Every other label stays as the provider published it.
 */
export function linkLabel(
  link: ExternalLink,
  all: ExternalLink[],
  fallback: string,
): string {
  const label = link.label ?? fallback;
  const same = all.filter((l) => (l.label ?? fallback) === label);
  const generic = /^studio profile$/i.test(label);
  if (!generic && same.length < 2) return label;
  const host = hostOf(link.url);
  if (host === null) return label;
  const hostShared = same.some((l) => l !== link && hostOf(l.url) === host);
  return hostShared ? (handleOf(link.url) ?? host) : host;
}
