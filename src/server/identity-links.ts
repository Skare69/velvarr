// Cross-provider identity policy: pure URL logic only, no I/O and no imports
// from the provider adapter. Performer and studio identity comes from links
// the providers publish on their own records (published-link-only rule);
// never from name matching. Scenes are never linked across providers. Policy
// edits land here without touching the TPDB/StashDB HTTP adapter.

import type { CatalogDetail, CatalogReference } from "../lib/contracts.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

const TPDB_PERFORMER_LINK_RE =
  /^https:\/\/(?:www\.)?theporndb\.net\/performers\/([0-9a-f-]{36})\/?$/i;
const STASH_PERFORMER_LINK_RE =
  /^https:\/\/(?:www\.)?stashdb\.org\/performers\/([0-9a-f-]{36})\/?$/i;
const TPDB_STUDIO_UUID_LINK_RE =
  /^https:\/\/(?:www\.)?theporndb\.net\/studios\/([0-9a-f-]{36})\/?$/i;
const TPDB_STUDIO_SLUG_LINK_RE =
  /^https:\/\/(?:www\.)?theporndb\.net\/sites\/([a-z0-9][a-z0-9-]{0,63})\/?$/i;
const STASH_STUDIO_LINK_RE =
  /^https:\/\/(?:www\.)?stashdb\.org\/studios\/([0-9a-f-]{36})\/?$/i;

/** Hosts whose <handle> path names exactly one person. A handle is globally
 * unique on these hosts, which is what makes a shared URL merge evidence for
 * a person; anything that is not an identity page (a studio homepage on
 * chaturbate, a pornhub video, a reddit community) must never merge people
 * and yields no key at all. */
const IDENTITY_HOSTS: Record<string, true> = {
  "iafd.com": true,
  "instagram.com": true,
  "twitter.com": true,
  "x.com": true,
  "onlyfans.com": true,
  "linktr.ee": true,
  "chaturbate.com": true,
  "tiktok.com": true,
  "xvideos.com": true,
  "pornhub.com": true,
  "reddit.com": true,
};

/** Hosts where the first path segment is a bucket word and only that exact
 * bucket is an identity page; every other path is content, not a person. */
const IDENTITY_BUCKETS: Record<string, readonly string[]> = {
  "xvideos.com": ["profiles"],
  "pornhub.com": ["model", "pornstar", "users"],
  "reddit.com": ["user"],
};

/** Normalized identity key for a third-party profile URL, undefined when the
 * URL is not an identity-scoped page on an allowlisted host. Keys are
 * host/handle: lowercased host (www. stripped) + handle (kind segments like
 * user/model/pornstar/profiles dropped, one leading @ stripped, query/hash/
 * trailing slash gone), so the same profile published with case, www, and
 * formatting differences collapses to one key. IAFD is special-cased because
 * its identity lives in a perfid= path segment, not a leading one. */
export function identityLinkKey(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined; // not a URL at all
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (IDENTITY_HOSTS[host] !== true) return undefined;
  if (host === "iafd.com") {
    const seg = parsed.pathname
      .split("/")
      .find((s) => s.toLowerCase().startsWith("perfid="));
    const perfid = seg?.slice("perfid=".length).toLowerCase();
    return perfid !== undefined && perfid !== ""
      ? `iafd.com/perfid=${perfid}`
      : undefined;
  }
  const segments = parsed.pathname.split("/").filter((s) => s !== "");
  const buckets = IDENTITY_BUCKETS[host];
  if (
    buckets !== undefined &&
    !buckets.includes(segments[0]?.toLowerCase() ?? "")
  ) {
    return undefined; // content path (pornhub /video, reddit /r), not a profile
  }
  if (buckets !== undefined) segments.shift(); // drop the kind segment
  const handle = segments.shift()?.replace(/^@/, "").toLowerCase();
  return handle !== undefined && handle !== ""
    ? `${host}/${handle}`
    : undefined;
}

/** Explicit cross-provider identity for a catalog detail, taken only from
 * provider-published URLs on the record itself. Identity is performer-level
 * AND studio-level, both from published URLs only; never fuzzy-name matching,
 * and scenes are never linked across providers. Returns exactly one of
 * linked / unlinkedReason. */
export function crossProviderLink(detail: CatalogDetail): {
  linked?: CatalogReference;
  unlinkedReason?: string;
} {
  const kind = detail.reference.kind;
  const fromTpdb = detail.reference.provider === "tpdb";
  if (kind === "performer") {
    const re = fromTpdb ? STASH_PERFORMER_LINK_RE : TPDB_PERFORMER_LINK_RE;
    for (const link of detail.links) {
      const m = re.exec(link.url);
      const linkedId = m?.[1];
      if (linkedId !== undefined && isUuid(linkedId)) {
        return {
          linked: {
            provider: fromTpdb ? "stashdb" : "tpdb",
            kind: "performer",
            id: linkedId.toLowerCase(),
          },
        };
      }
    }
    return {
      unlinkedReason: `no explicit ${
        fromTpdb ? "StashDB" : "TPDB"
      } performer URL on the ${fromTpdb ? "TPDB" : "StashDB"} performer record`,
    };
  }
  if (kind === "studio") {
    if (!fromTpdb) {
      // StashDB publishes its TPDB counterpart in `urls` in two observed
      // forms: a canonical /studios/<uuid> and a /sites/<slug>. The slug
      // stays a slug here because getCatalogDetail canonicalizes it through
      // TPDB /sites/<slug>. A uuid form outranks a slug form when a record
      // publishes both.
      let slug: string | undefined;
      for (const link of detail.links) {
        const uuid = TPDB_STUDIO_UUID_LINK_RE.exec(link.url)?.[1];
        if (uuid !== undefined && isUuid(uuid)) {
          return {
            linked: {
              provider: "tpdb",
              kind: "studio",
              id: uuid.toLowerCase(),
            },
          };
        }
        const m = TPDB_STUDIO_SLUG_LINK_RE.exec(link.url);
        if (m?.[1] !== undefined && slug === undefined) slug = m[1];
      }
      if (slug !== undefined) {
        return {
          linked: {
            provider: "tpdb",
            kind: "studio",
            id: slug.toLowerCase(),
          },
        };
      }
    } else {
      // Symmetry only: TPDB site rows publish no external ids today, so this
      // match has no live producer yet — kept so a future publication links
      // itself without new machinery.
      for (const link of detail.links) {
        const m = STASH_STUDIO_LINK_RE.exec(link.url);
        const linkedId = m?.[1];
        if (linkedId !== undefined && isUuid(linkedId)) {
          return {
            linked: {
              provider: "stashdb",
              kind: "studio",
              id: linkedId.toLowerCase(),
            },
          };
        }
      }
    }
    return {
      unlinkedReason: `no explicit ${
        fromTpdb ? "StashDB" : "TPDB"
      } studio URL on the ${fromTpdb ? "TPDB" : "StashDB"} studio record`,
    };
  }
  return {
    unlinkedReason:
      "cross-provider identity is performer-level only; scenes are never linked across providers",
  };
}
