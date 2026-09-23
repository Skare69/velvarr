// API regression tests: privilege, CSRF, session, library denial, outage honesty.
// Runs handlers directly against local fixture servers. No real network, no real providers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resetMetaCache } from "../src/server/providers.ts";
import { countPendingApprovals } from "../src/lib/approvals.ts";
import type { RouteDef } from "../src/app/api/[...path]/admission.ts";
import { routes as authRoutes } from "../src/app/api/[...path]/routes/auth.ts";
import { routes as requestRoutes } from "../src/app/api/[...path]/routes/requests.ts";
import { routes as followRoutes } from "../src/app/api/[...path]/routes/follows.ts";
import { routes as catalogRoutes } from "../src/app/api/[...path]/routes/catalog.ts";
import { routes as browseRoutes } from "../src/app/api/[...path]/routes/browse.ts";
import { routes as libraryRoutes } from "../src/app/api/[...path]/routes/library.ts";
import { routes as removalRoutes } from "../src/app/api/[...path]/routes/removals.ts";
import { routes as adminRoutes } from "../src/app/api/[...path]/routes/admin.ts";
import { routes as discoverRoutes } from "../src/app/api/[...path]/routes/discover.ts";

test("route tables never shadow: every request shape matches at most one def", () => {
  const all: RouteDef[] = [
    ...authRoutes,
    ...requestRoutes,
    ...followRoutes,
    ...catalogRoutes,
    ...browseRoutes,
    ...libraryRoutes,
    ...removalRoutes,
    ...adminRoutes,
    ...discoverRoutes,
  ];
  // Exact match semantics (method + segment count + literal/:param) make the
  // fold order irrelevant ONLY if no two defs can match the same request. A
  // param at position i makes any other def with that method+length a
  // conflict — the param would swallow its literal depending on fold order.
  const shadow = (a: RouteDef, b: RouteDef): boolean =>
    a.method === b.method &&
    a.segments.length === b.segments.length &&
    a.segments.every(
      (pat, i) =>
        pat.startsWith(":") ||
        b.segments[i]!.startsWith(":") ||
        pat === b.segments[i],
    );
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      assert.ok(
        !shadow(all[i]!, all[j]!),
        `${all[i]!.method} [${all[i]!.segments}] is shadowed by ${all[j]!.method} [${all[j]!.segments}]`,
      );
    }
  }
  // The whole pre-session surface: exactly these routes answer without
  // admission, nothing else.
  const open = all
    .filter((r) => r.auth === "open")
    .map((r) => `${r.method} /${r.segments.join("/")}`)
    .sort();
  assert.deepEqual(open, [
    "GET /health",
    "GET /status",
    "POST /login",
    "POST /logout",
    "POST /setup",
    "POST /setup/inspect",
  ]);
});

// Isolated environment BEFORE importing route/storage modules.
process.env.VELVARR_DATA_DIR = mkdtempSync(join(tmpdir(), "velvarr-api-test-"));
process.env.VELVARR_SECRET_KEY = "ab".repeat(32);
process.env.VELVARR_SETUP_SECRET = "setup-secret-".repeat(4);
process.env.VELVARR_ORIGIN = "http://127.0.0.1:5577";
delete process.env.TPDB_API_TOKEN;
delete process.env.STASHDB_API_KEY;

const ORIGIN = process.env.VELVARR_ORIGIN;

// --- fixture identities (32-hex Jellyfin-style IDs) ---

const SERVER_ID = "c".repeat(32);
const OWNER_ID = "d".repeat(32);
const MEMBER_ID = "e".repeat(32);
const MEMBER2_ID = "4".repeat(32);
const DISABLED_ID = "f0".repeat(16);
const OUTSIDER_ID = "6".repeat(32);
const NOGRANT_ID = "7".repeat(32);
const MOVIES_LIB = "a".repeat(32);
const SHOWS_LIB = "b".repeat(32);
const ITEM_MOVIE = "1".repeat(32);
const ITEM_SHOW = "2".repeat(32);
const TPDB_MOVIE = "2a2b3c4d-0000-0000-0000-000000000001";
const TPDB_MOVIE2 = "2a2b3c4d-0000-0000-0000-000000000002";
const TPDB_MOVIE3 = "2a2b3c4d-0000-0000-0000-000000000003";
const TPDB_MOVIE4 = "2a2b3c4d-0000-0000-0000-000000000004";
// Only used by the performer-filmography bulk test: TPDB_MOVIE3 already
// carries approved intents from earlier tests, and an active-intent row
// would collide with the bulk's new pending intent and show up in the
// owner's request list.
const TPDB_MOVIE5 = "2a2b3c4d-0000-0000-0000-000000000005";
// The bulk cap test's own movie: a filmography page that never runs dry
// (see the TPDB_PERFORMER3 branch) files this id over and over, so it must
// not collide with any other test's intents.
const TPDB_MOVIE6 = "2a2b3c4d-0000-0000-0000-000000000006";
// The admin user-row test's own movies: never filed elsewhere, so the
// owner's request count moves 0 -> 2 with no duplicate-intent collisions.
const TPDB_MOVIE7 = "2a2b3c4d-0000-0000-0000-000000000007";
const TPDB_MOVIE8 = "2a2b3c4d-0000-0000-0000-000000000008";
// Second row on the /movies snapshot: carries TPDB_STUDIO2 and the
// counterpart-less genre for the unified facet shelves.
const TPDB_MOVIE9 = "2a2b3c4d-0000-0000-0000-000000000009";
const TPDB_PERFORMER3 = "2a2b3c4d-0000-0000-0000-00000000000d";
const TPDB_PERFORMER = "2a2b3c4d-0000-0000-0000-00000000000f";
const TPDB_PERFORMER2 = "2a2b3c4d-0000-0000-0000-00000000000e";
// A published cross-provider pair: the TPDB record links to the StashDB one,
// so following either follows both. Fresh ids — every other performer follow
// in this file must stay single-provider.
const TPDB_PERFORMER4 = "2a2b3c4d-0000-0000-0000-00000000000c";
const STASH_PERFORMER2 = "4c4d5e6f-0000-0000-0000-0000000000d5";
const TPDB_STUDIO = "2a2b3c4d-0000-0000-0000-0000000000a1";
// Second studio on the /movies snapshot: no published counterpart anywhere,
// so the unified Studios shelf can prove unlinked tiles still render.
const TPDB_STUDIO2 = "2a2b3c4d-0000-0000-0000-0000000000a2";
const STASH_STUDIO = "3b3c4d5e-0000-0000-0000-0000000000b2";
const STASH_SCENE = "4c4d5e6f-0000-0000-0000-0000000000c3";
const STASH_PERFORMER = "4c4d5e6f-0000-0000-0000-0000000000d4";
const TAG_A = "cc000000-0000-0000-0000-000000000001";
const TAG_B = "cc000000-0000-0000-0000-000000000002";
// Second movie tag: its counterpart lookup answers only near-misses, so the
// Genres shelf proves unlinked tags still render.
const TAG_C = "cc000000-0000-0000-0000-000000000003";
// StashDB's same-normalized-name twin of TAG_A ("fixture-tag-a"): pairing
// folds case and separators exactly, and never fuzzes.
const TAG_D = "cc000000-0000-0000-0000-000000000004";
// Family-matching fixtures: a hidden tag whose label is a whole word of a
// longer label ("Anal" in "Anal Creampie") must hide the longer-tagged
// title; a letter overlap with no word boundary ("Analingus") must never
// match. Served only through the q=Family branch and the family filmography
// route, so the shared /movies snapshot rows — and every assertion pinned
// to them — stay untouched.
const TAG_FAMILY_PARENT = "cc000000-0000-0000-0000-000000000005";
const TAG_FAMILY_CHILD = "cc000000-0000-0000-0000-000000000006";
const TAG_FAMILY_BOUNDARY = "cc000000-0000-0000-0000-000000000007";
const TPDB_MOVIE_FAMILY_EXACT = "2a2b3c4d-0000-0000-0000-000000000010";
const TPDB_MOVIE_FAMILY_CHILD = "2a2b3c4d-0000-0000-0000-000000000011";
const TPDB_MOVIE_FAMILY_WIDE = "2a2b3c4d-0000-0000-0000-000000000012";
const TPDB_PERFORMER_FAMILY = "2a2b3c4d-0000-0000-0000-000000000013";
// StashDB serves images from stashdb.org/images/<uuid>; a provider-hosted
// URL so the artwork gate accepts it end to end.
const STASH_IMAGE =
  "https://stashdb.org/images/5e6f7a8b-0000-0000-0000-0000000000e1";

interface FxUser {
  id: string;
  name: string;
  admin: boolean;
  disabled: boolean;
  remote: boolean;
  playback: boolean;
  /** Jellyfin PrimaryImageTag; absent when the user has no avatar upstream. */
  imageTag?: string;
}

const fx = {
  adminKey: "jf-admin-key-9",
  serverId: SERVER_ID,
  tokenCounter: 0,
  users: [
    {
      id: OWNER_ID,
      name: "owner",
      admin: true,
      disabled: false,
      remote: true,
      playback: true,
    },
    {
      id: MEMBER_ID,
      name: "member",
      admin: false,
      disabled: false,
      remote: true,
      playback: true,
    },
    {
      id: MEMBER2_ID,
      name: "member2",
      admin: false,
      disabled: false,
      remote: true,
      playback: true,
      // The only avatar holder; the owner deliberately has none so avatar
      // absence is asserted on a stable identity.
      imageTag: "member2-image-1",
    },
    {
      id: DISABLED_ID,
      name: "wrecked",
      admin: false,
      disabled: false,
      remote: true,
      playback: true,
    },
    {
      id: OUTSIDER_ID,
      name: "outsider",
      admin: false,
      disabled: false,
      remote: true,
      playback: true,
    },
    {
      id: NOGRANT_ID,
      name: "nogrants",
      admin: false,
      disabled: false,
      remote: true,
      playback: true,
    },
  ] as FxUser[],
  tokens: new Map<string, string>(), // access token -> user id
  impersonate: null as string | null, // force /Users/Me identity for regression testing

  fail: { items: 0, views: 0, me401: 0 },
  // Wired only inside the removal impact test: every request either fixture
  // server sees while it is on, so the test can prove the preview is GET-only.
  journalOn: false,
  journal: [] as { method: string; path: string }[],
  libraries: [
    { id: MOVIES_LIB, name: "Movies", type: "movies" },
    { id: SHOWS_LIB, name: "Shows", type: "homevideos" },
  ],
  grants: new Map<string, string[]>(), // user id -> allowed library ids (missing entry = unrestricted)
  items: [
    { Id: ITEM_MOVIE, Name: "Alpha Movie", libraryId: MOVIES_LIB },
    { Id: ITEM_SHOW, Name: "Beta Show", libraryId: SHOWS_LIB },
  ],
};

// Sequential tests share session cookies through this module state.
let owner = "";
let member = "";
let member2 = "";
let nogrants = "";

const PNG_1PX = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

function jfUser(user: FxUser) {
  return {
    Id: user.id,
    Name: user.name,
    Policy: {
      IsAdministrator: user.admin,
      IsDisabled: user.disabled,
      EnableRemoteAccess: user.remote,
      EnableMediaPlayback: user.playback,
    },
    ...(user.imageTag ? { PrimaryImageTag: user.imageTag } : {}),
  };
}

function jfItem(item: (typeof fx.items)[number]) {
  return {
    Id: item.Id,
    Name: item.Name,
    ProductionYear: 2020,
    Overview: `Overview of ${item.Name}`,
    RunTimeTicks: 6_000_000_000,
    LocationType: "FileSystem",
    MediaType: "Video",
    ImageTags: { Primary: "primary" },
    Path: `/media/${item.Id}.mkv`,
    MediaSources: [
      {
        Id: item.Id,
        Path: `/media/${item.Id}.mkv`,
        Protocol: "File",
        SupportsDirectPlay: true,
        // Real Jellyfin sources always report a positive Size; the verdict
        // treats a size-less source as a placeholder.
        Size: 600_000_000,
      },
    ],
  };
}

function grantsFor(userId: string | undefined): string[] | null {
  if (!userId) return null;
  const entry = fx.grants.get(userId);
  return entry ? entry : null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function jellyfinHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://fixture");
  const p = url.pathname;
  const token = /Token="([^"]*)"/.exec(
    String(req.headers.authorization ?? ""),
  )?.[1];
  const userId = token ? (fx.tokens.get(token) ?? null) : null;
  if (fx.journalOn) fx.journal.push({ method: req.method ?? "", path: p });

  if (p === "/System/Info/Public")
    return json(res, 200, { Id: fx.serverId, ServerName: "FixtureJF" });
  if (p === "/System/Info") {
    if (token !== fx.adminKey) return json(res, 401, {});
    return json(res, 200, { ServerName: "FixtureJF", Version: "10.9.0" });
  }
  if (p === "/Users/AuthenticateByName" && req.method === "POST") {
    const body = await readBody(req);
    const match = fx.users.find(
      (entry) =>
        entry.name === body.Username && body.Pw === `pass-${entry.name}`,
    );
    if (!match || match.disabled) return json(res, 401, {});
    fx.tokenCounter += 1;
    const access = `jf-${match.id}-${fx.tokenCounter}`;
    fx.tokens.set(access, match.id);
    return json(res, 200, {
      User: jfUser(match),
      AccessToken: access,
      ServerId: fx.serverId,
    });
  }
  if (p === "/Users/Me") {
    if (fx.fail.me401 > 0) {
      fx.fail.me401 -= 1;
      return json(res, 401, {});
    }
    const effectiveId = fx.impersonate ?? userId;
    const effective = fx.users.find((entry) => entry.id === effectiveId);
    if (!effective) return json(res, 401, {});
    return json(res, 200, jfUser(effective));
  }
  if (p === "/Users") {
    if (token !== fx.adminKey) return json(res, 401, {});
    return json(res, 200, fx.users.map(jfUser));
  }
  // User avatar: mirrors the item image handler — same bytes, same
  // content-type, admin-key callers only, 404 without an upstream tag.
  if (/^\/Users\/[0-9a-f]{32}\/Images\/Primary$/.test(p)) {
    if (token !== fx.adminKey) return json(res, 401, {});
    const uid = /Users\/([0-9a-f]{32})\/Images/.exec(p)?.[1];
    const user = fx.users.find((entry) => entry.id === uid);
    if (!user?.imageTag) return json(res, 404, {});
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from(PNG_1PX));
    return;
  }
  if (/^\/Users\/[^/]+\/Views$/.test(p) || p === "/Library/MediaFolders") {
    if (fx.fail.views > 0) {
      fx.fail.views -= 1;
      return json(res, 500, {});
    }
    const grants = grantsFor(userId ?? undefined);
    const libs = grants
      ? fx.libraries.filter((lib) => grants.includes(lib.id))
      : fx.libraries;
    return json(res, 200, {
      Items: libs.map((lib) => ({
        Id: lib.id,
        Name: lib.name,
        CollectionType: lib.type,
      })),
      TotalRecordCount: libs.length,
    });
  }
  // listLibraryItems always queries /Users/{id}/Items with camelCase params.
  if (/^\/Users\/[0-9a-f]{32}\/Items$/.test(p)) {
    if (fx.fail.items > 0) {
      fx.fail.items -= 1;
      return json(res, 500, {});
    }
    const grants = grantsFor(userId ?? undefined);
    const parentId = url.searchParams.get("parentId");
    if (parentId && grants && !grants.includes(parentId))
      return json(res, 404, {});
    let list = fx.items.filter(
      (item) => !grants || grants.includes(item.libraryId),
    );
    if (parentId) list = list.filter((item) => item.libraryId === parentId);
    const search = url.searchParams.get("searchTerm");
    if (search)
      list = list.filter((item) =>
        item.Name.toLowerCase().includes(search.toLowerCase()),
      );
    const ids = url.searchParams.get("ids");
    if (ids) list = list.filter((item) => ids.split(",").includes(item.Id));
    const start = Number(url.searchParams.get("startIndex") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? list.length);
    return json(res, 200, {
      Items: list.slice(start, start + limit).map(jfItem),
      TotalRecordCount: list.length,
    });
  }
  // getLibraryItem proves playback with a real PlaybackInfo verdict.
  if (/^\/Items\/[0-9a-f]{32}\/PlaybackInfo$/.test(p) && req.method === "GET") {
    const itemId = /Items\/([0-9a-f]{32})\/PlaybackInfo/.exec(p)?.[1];
    const item = fx.items.find((entry) => entry.Id === itemId);
    if (!item) return json(res, 404, {});
    return json(res, 200, { MediaSources: jfItem(item).MediaSources });
  }
  // Membership proof on Jellyfin 12.0.0: ancestors, never query scoping.
  // Jellyfin reports the true library regardless of Velvarr grants; Velvarr
  // compares it against the account's effective libraries.
  if (/^\/Items\/[0-9a-f]{32}\/Ancestors$/.test(p) && req.method === "GET") {
    const itemId = /Items\/([0-9a-f]{32})\/Ancestors/.exec(p)?.[1];
    const item = fx.items.find((entry) => entry.Id === itemId);
    if (!item) return json(res, 404, {});
    return json(res, 200, [
      { Id: item.libraryId, Name: "Fixture library", Type: "CollectionFolder" },
      { Id: "f".repeat(32), Name: "media", Type: "UserRootFolder" },
    ]);
  }
  if (/^\/(?:Users\/[^/]+\/)?Items\/[0-9a-f]{32}\/Images\/Primary$/.test(p)) {
    const itemId = /Items\/([0-9a-f]{32})\/Images/.exec(p)?.[1];
    const item = fx.items.find((entry) => entry.Id === itemId);
    const grants = grantsFor(userId ?? undefined);
    if (!item || (grants && !grants.includes(item.libraryId)))
      return json(res, 404, {});
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from(PNG_1PX));
    return;
  }
  json(res, 404, {});
}

const whisparrKey = "wh-fixture-key";

// Stored Whisparr movie backing the removal impact preview. Its path runs
// through the configured "/data/whisparr" -> "/media" mapping onto ITEM_MOVIE.
const whisparrMovies: {
  id: number;
  title: string;
  monitored: boolean;
  path: string;
  hasFile: boolean;
  movieFileId: number;
  sizeOnDisk: number;
  added: string;
  tmdbId: number;
  tpdbId: string;
  stashId?: string;
  foreignId: string;
  itemType: string;
  statistics: { movieFileCount: number; sizeOnDisk: number };
}[] = [
  {
    id: 411,
    title: "Alpha Movie",
    monitored: true,
    path: `/data/whisparr/${ITEM_MOVIE}.mkv`,
    hasFile: true,
    movieFileId: 5,
    sizeOnDisk: 741_234_567,
    added: "2026-09-10T12:00:00Z",
    tmdbId: 0,
    tpdbId: TPDB_MOVIE,
    foreignId: `tpdbId:${TPDB_MOVIE}`,
    itemType: "movie",
    statistics: { movieFileCount: 2, sizeOnDisk: 741_234_567 },
  },
];

async function whisparrHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://fixture");
  if (req.headers["x-api-key"] !== whisparrKey) return json(res, 401, {});
  if (url.pathname === "/api/v3/system/status")
    return json(res, 200, { version: "3.4.0.1387", appName: "Whisparr" });
  if (url.pathname === "/api/v3/rootfolder")
    return json(res, 200, [{ id: 1, path: "/movies" }]);
  if (url.pathname === "/api/v3/qualityprofile")
    return json(res, 200, [{ id: 1, name: "HD" }]);
  if (fx.journalOn)
    fx.journal.push({ method: req.method ?? "", path: url.pathname });
  // Exact-identity stored-item read (GET): the removal impact preview's only
  // Whisparr contact.
  if (url.pathname === "/api/v3/movie") {
    const tpdbId = url.searchParams.get("tpdbId");
    const stashId = url.searchParams.get("stashId");
    return json(
      res,
      200,
      whisparrMovies.filter(
        (m) =>
          (tpdbId !== null && m.tpdbId === tpdbId) ||
          (stashId !== null && m.stashId === stashId),
      ),
    );
  }
  json(res, 404, {});
}

async function differentServerHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  json(res, 200, { Id: "dead".repeat(8), ServerName: "OtherServer" });
}

// --- harness ---

let jellyfinServer: Server;
let whisparrServer: Server;
let otherServer: Server;
let otherServerUrl: string;
let jellyfinUrl: string;
let whisparrUrl: string;
let tpdbServer: Server;
let tpdbUrl: string;
let stashdbServer: Server;
let stashdbUrl: string;

// --- M2 fixtures: TPDB metadata + artwork ---

const tpdbToken = "tpdb-fixture-token";
const tpdbFx = {
  fail: 0,
  failPaths: [] as string[],
  calls: 0,
  imageAuth: "unset",
};

function tpdbMovieRow(id: string) {
  return {
    id,
    title: `Fixture Movie ${id.slice(-1)}`,
    date: "2024-02-03",
    description: "Fixture description",
    url: `https://theporndb.net/movies/${id}`,
    // Numeric id rides along (provider-native shape): the UUID is the
    // external-API identity, the numeric id the tag-filter encoding.
    site: { name: "Fixture Studio", uuid: TPDB_STUDIO },
    posters: { full: "https://cdn.theporndb.net/fixture-poster.jpg" },
    performers: [],
    tags: [{ id: 70, uuid: TAG_A, name: "Fixture Tag A" }],
    scenes: [],
  };
}
/** The three family-proof rows: exact-label parent, whole-word child, and a
 * letter-overlap tag with no word boundary. One source so the q=Family
 * browse/search snapshot and the family filmography stay identical. */
function tpdbFamilyMovieRows() {
  const row = (
    id: string,
    title: string,
    uuid: string,
    name: string,
    numeric: number,
  ) => ({
    ...tpdbMovieRow(id),
    title,
    tags: [{ id: numeric, uuid, name }],
  });
  return [
    row(TPDB_MOVIE_FAMILY_EXACT, "Family Exact", TAG_FAMILY_PARENT, "Anal", 72),
    row(
      TPDB_MOVIE_FAMILY_CHILD,
      "Family Child",
      TAG_FAMILY_CHILD,
      "Anal Creampie",
      73,
    ),
    row(
      TPDB_MOVIE_FAMILY_WIDE,
      "Family Wide",
      TAG_FAMILY_BOUNDARY,
      "Analingus",
      74,
    ),
  ];
}

function tpdbSiteRow(id: string) {
  return {
    uuid: id,
    id: 4242,
    name: "Fixture Studio",
    url: "https://fixture-studio.example",
    description: "Fixture studio description",
    poster: "https://cdn.theporndb.net/fixture-poster.jpg",
  };
}

async function tpdbHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://fixture");
  const p = url.pathname;
  tpdbFx.calls += 1;
  const auth = String(req.headers.authorization ?? "");
  // Artwork pass-through: no credential may ever arrive here.
  if (p.endsWith(".svg")) {
    tpdbFx.imageAuth = auth;
    res.writeHead(200, { "content-type": "image/svg+xml" });
    res.end(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/me")</script></svg>',
    );
    return;
  }
  if (p.endsWith(".png") || p.endsWith(".jpg")) {
    tpdbFx.imageAuth = auth;
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from(PNG_1PX));
    return;
  }
  if (tpdbFx.fail > 0) {
    tpdbFx.fail -= 1;
    return json(res, 500, {});
  }
  // Path-matched outage: fail specific upstream reads no matter how many
  // calls a route happens to issue around them.
  if (tpdbFx.failPaths.includes(p)) return json(res, 500, {});
  if (auth !== `Bearer ${tpdbToken}`) return json(res, 401, {});
  if (p === "/user") return json(res, 200, { data: { name: "Fixture TPDB" } });
  if (p === "/movies") {
    // Family-proof snapshot, isolated behind an exact q marker so the
    // shared unfiltered /movies rows keep feeding every existing
    // assertion unchanged.
    if (url.searchParams.get("q") === "Family") {
      return json(res, 200, {
        data: tpdbFamilyMovieRows(),
        meta: { total: 3 },
        links: {},
      });
    }
    // TPDB caps unfiltered totals at the fake 10000 marker; a countable
    // filter (q) yields a real total. Mirrors the live provider behavior.
    const realTotal = url.searchParams.get("q") !== null;
    return json(res, 200, {
      // Second row feeds the unified facet shelves an unlinked studio tile
      // (TPDB_STUDIO2) and a counterpart-less genre tile (TAG_C).
      data: [
        tpdbMovieRow(TPDB_MOVIE),
        {
          ...tpdbMovieRow(TPDB_MOVIE9),
          site: { name: "Second Studio", uuid: TPDB_STUDIO2 },
          tags: [{ id: 71, uuid: TAG_C, name: "Fixture Tag C" }],
        },
      ],
      meta: { total: realTotal ? 1 : 10000 },
      links: {},
    });
  }
  if (p === "/scenes") {
    return json(res, 200, {
      data: [tpdbMovieRow(TPDB_MOVIE2)],
      meta: { total: 10000 },
      links: {},
    });
  }
  if (p === "/performers") {
    return json(res, 200, {
      data: [{ id: TPDB_PERFORMER, name: "Fixture Performer" }],
      meta: { total: 1 },
      links: {},
    });
  }
  // The only performer record with a published counterpart URL; TPDB carries
  // these in extras.links, keyed by site name.
  if (p === `/performers/${TPDB_PERFORMER4}`) {
    return json(res, 200, {
      data: {
        id: TPDB_PERFORMER4,
        name: "Linked Fixture Performer",
        extras: {
          links: {
            stashdb: `https://stashdb.org/performers/${STASH_PERFORMER2}`,
          },
        },
      },
    });
  }
  if (p === "/sites") {
    return json(res, 200, {
      data: [tpdbSiteRow(TPDB_STUDIO)],
      meta: { total: 1 },
      links: {},
    });
  }
  if (p === `/sites/${TPDB_STUDIO}`)
    return json(res, 200, { data: tpdbSiteRow(TPDB_STUDIO) });
  if (p === "/tags") {
    // The suggestion path lists tags with no term and, for the magic
    // no-match term, an empty result — so the route's judged-suggestion
    // branch is reachable in tests.
    const empty = url.searchParams.get("q") === "zznomatchy";
    return json(res, 200, {
      data: empty
        ? []
        : [
            { id: 70, uuid: TAG_A, name: "Fixture Tag A" },
            { id: 194, uuid: TAG_B, name: "Fixture Tag B" },
          ],
      meta: { total: empty ? 0 : 2 },
      links: {},
    });
  }
  // Performer filmography (the paging-only route). The scenes route keeps a
  // provider `next` link alive so the bulk cap is reachable across pages;
  // the movies route has none, so a bulk pass stops after one page.
  if (p === `/performers/${TPDB_PERFORMER}/scenes`)
    return json(res, 200, {
      data: [tpdbMovieRow(TPDB_MOVIE2)],
      meta: { total: 1 },
      links: { next: "https://fixture.test/next" },
    });
  if (p === `/performers/${TPDB_PERFORMER}/movies`)
    // Fresh movie id: TPDB_MOVIE3 already carries approved intents from the
    // autoApprove and availability tests, which would both collide with the
    // bulk's new pending intent (active-intent unique index) and appear in
    // the owner's request list below. The credited partner feeds the
    // co-appearance rail; credits never reach requests.
    return json(res, 200, {
      data: [
        {
          ...tpdbMovieRow(TPDB_MOVIE5),
          performers: [{ id: TPDB_PERFORMER4, name: "Dee Vine" }],
        },
      ],
      meta: { total: 1 },
      links: {},
    });
  // TPDB_PERFORMER3's movie filmography keeps a provider `next` link alive,
  // so a bulk pass reaches the hard cap. (TPDB_PERFORMER's movie route stops
  // after one page, which is what the single-page bulk test asserts.)
  if (p === `/performers/${TPDB_PERFORMER3}/movies`)
    return json(res, 200, {
      data: [tpdbMovieRow(TPDB_MOVIE6)],
      meta: { total: 1 },
      links: { next: "https://fixture.test/next" },
    });
  // Family-proof filmography: every row this performer could return is one
  // of the three family rows, so hide/exclude/include behavior is fully
  // observable on a single page.
  if (p === `/performers/${TPDB_PERFORMER_FAMILY}/movies`)
    return json(res, 200, {
      data: tpdbFamilyMovieRows(),
      meta: { total: 3 },
      links: {},
    });
  if (p === `/movies/${TPDB_MOVIE}`)
    return json(res, 200, { data: tpdbMovieRow(TPDB_MOVIE) });
  json(res, 404, {});
}

// --- M3 fixtures: StashDB graphql ---

const stashdbKey = "stash-fixture-key";
const stashdbFx = { fail: 0, calls: 0, lastQuery: "", lastVars: "" };

async function stashdbHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (String(req.headers.apikey ?? "") !== stashdbKey) {
    return json(res, 401, {});
  }
  if (stashdbFx.fail > 0) {
    stashdbFx.fail -= 1;
    return json(res, 500, {});
  }
  stashdbFx.calls += 1;
  const body = await readBody(req);
  const query = typeof body.query === "string" ? body.query : "";
  stashdbFx.lastVars = JSON.stringify(body.variables ?? null);
  if (query.includes("queryStudios")) {
    // studioCounterpart matches the exact stored URL: the one published
    // theporndb.net/studios/<uuid> pair resolves; every other URL is
    // authoritative absence.
    const vars = body.variables as
      { url?: unknown; input?: { url?: unknown } } | undefined;
    const url = vars?.url ?? vars?.input?.url;
    return json(res, 200, {
      data: {
        queryStudios:
          url === `https://theporndb.net/studios/${TPDB_STUDIO}`
            ? [{ id: STASH_STUDIO, name: "Fixture Studio", deleted: false }]
            : [],
      },
    });
  }
  if (query.includes("searchStudio")) {
    return json(res, 200, {
      data: {
        searchStudio: [
          { id: STASH_STUDIO, name: "Fixture Studio", deleted: false },
        ],
      },
    });
  }
  if (query.includes("queryScenes")) {
    return json(res, 200, {
      data: {
        queryScenes: {
          count: 1,
          scenes: [
            {
              id: STASH_SCENE,
              title: "Fixture Scene",
              date: "2024-05-06",
              duration: 600,
              urls: [],
              images: [{ url: STASH_IMAGE }],
              studio: { id: STASH_STUDIO, name: "Fixture Studio" },
              tags: [{ id: TAG_B, name: "Fixture Stash Tag" }],
              performers: [],
            },
          ],
        },
      },
    });
  }
  if (query.includes("searchPerformers")) {
    return json(res, 200, {
      data: {
        searchPerformers: {
          count: 1,
          performers: [
            {
              id: STASH_PERFORMER,
              name: "Fixture Performer",
              deleted: false,
              images: [],
            },
          ],
        },
      },
    });
  }
  // Only the counterpart of the linked TPDB record resolves; every other
  // StashDB performer detail stays absent (data null), as before.
  if (query.includes("findPerformer")) {
    const wanted = (body.variables as { id?: unknown } | undefined)?.id;
    return json(res, 200, {
      data:
        wanted === STASH_PERFORMER2
          ? {
              findPerformer: {
                id: STASH_PERFORMER2,
                name: "Linked Fixture Performer",
                deleted: false,
                aliases: [],
                urls: [],
                images: [],
              },
            }
          : null,
    });
  }
  if (query.includes("searchTag")) {
    // The counterpart lookup searches the full tag name; the suggestion
    // path searches "Fixture". One same-normalized-name row (TAG_D, served
    // only for the "Fixture Tag A" term) proves exact pairing; every other
    // term answers only near-misses that must stay unlinked.
    const vars = body.variables as { t?: unknown } | undefined;
    const term = typeof vars?.t === "string" ? vars.t : "";
    return json(res, 200, {
      data: {
        searchTag: term.toLowerCase().includes("tag a")
          ? [{ id: TAG_D, name: "fixture-tag-a" }]
          : [{ id: TAG_B, name: "Fixture Stash Tag" }],
      },
    });
  }
  // Studio detail read (discover enrichment, catalog detail): one studio
  // with a provider-hosted logo; every other id is authoritative absence.
  if (query.includes("findStudio")) {
    const wanted = (body.variables as { id?: unknown } | undefined)?.id;
    return json(res, 200, {
      data:
        wanted === STASH_STUDIO
          ? {
              findStudio: {
                id: STASH_STUDIO,
                name: "Fixture Studio",
                deleted: false,
                // The published cross-provider URL is what pairs this
                // studio with its TPDB counterpart on the Studios rail.
                urls: [
                  {
                    url: `https://theporndb.net/studios/${TPDB_STUDIO}`,
                    type: "STUDIO",
                  },
                ],
                images: [{ url: STASH_IMAGE }],
                parent: null,
                child_studios: [],
              },
            }
          : null,
    });
  }
  json(res, 200, { data: null });
}

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ server: Server; url: string }> {
  const { promise, resolve } = Promise.withResolvers<{
    server: Server;
    url: string;
  }>();
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as { port: number };
    resolve({ server, url: `http://127.0.0.1:${address.port}` });
  });
  return promise;
}

function segments(pathname: string): string[] {
  return pathname
    .replace(/^\/+/, "")
    .split("/")
    .map((part) => decodeURIComponent(part));
}

type Handler = (
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) => Promise<Response>;
let api: { GET: Handler; POST: Handler; PATCH: Handler; DELETE: Handler };
let closeStorage: () => void;
let getAcquisitionByReference: (media: {
  provider: "tpdb" | "stashdb";
  kind: "movie" | "scene";
  id: string;
}) => { id: string; state: string } | null;
let recordAcquisitionObservation: (
  id: string,
  observation: unknown,
  claimToken?: string,
) => unknown;

async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  init: {
    origin?: string | null;
    cookie?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin) headers.origin = origin;
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  Object.assign(headers, init.headers);
  const request = new Request(ORIGIN + path, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const handler =
    method === "GET"
      ? api.GET
      : method === "POST"
        ? api.POST
        : method === "DELETE"
          ? api.DELETE
          : api.PATCH;
  return handler(request, {
    params: Promise.resolve({ path: segments(new URL(path, ORIGIN).pathname) }),
  });
}

function cookieOf(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function loginAs(name: string): Promise<string> {
  const res = await call("POST", "/api/login", {
    body: { username: name, password: `pass-${name}` },
  });
  const text = await res.text();
  assert.equal(
    res.status,
    200,
    `login as ${name} failed: ${res.status} ${text}`,
  );
  const cookie = cookieOf(res);
  assert.match(cookie, /^velvarr_session=/);
  return cookie;
}

async function errorShape(
  response: Response,
  minStatus = 400,
): Promise<{ code: string; message: string }> {
  assert.ok(
    response.status >= minStatus,
    `expected status >= ${minStatus}, got ${response.status}`,
  );
  const body = (await response.json()) as {
    error?: { code?: unknown; message?: unknown };
  };
  assert.ok(
    body.error &&
      typeof body.error.code === "string" &&
      typeof body.error.message === "string",
  );
  return body.error as { code: string; message: string };
}

// --- tests ---

before(async () => {
  ({ server: jellyfinServer, url: jellyfinUrl } =
    await listen(jellyfinHandler));
  ({ server: whisparrServer, url: whisparrUrl } =
    await listen(whisparrHandler));
  ({ server: tpdbServer, url: tpdbUrl } = await listen(tpdbHandler));
  ({ server: stashdbServer, url: stashdbUrl } = await listen(stashdbHandler));
  ({ server: otherServer, url: otherServerUrl } = await listen(
    differentServerHandler,
  ));
  // Dynamic import required: the env block above must exist before storage binds,
  // and the [...path] bracket directory is not addressable as a static ESM specifier.
  const routeHref = pathToFileURL(
    fileURLToPath(
      new URL("../src/app/api/[...path]/route.ts", import.meta.url),
    ),
  ).href;
  api = (await import(routeHref)) as {
    GET: Handler;
    POST: Handler;
    PATCH: Handler;
    DELETE: Handler;
  };
  const storageHref = pathToFileURL(
    fileURLToPath(new URL("../src/server/storage.ts", import.meta.url)),
  ).href;
  ({ closeStorage, getAcquisitionByReference, recordAcquisitionObservation } =
    (await import(storageHref)) as {
      closeStorage: () => void;
      getAcquisitionByReference: (media: {
        provider: "tpdb" | "stashdb";
        kind: "movie" | "scene";
        id: string;
      }) => { id: string; state: string } | null;
      recordAcquisitionObservation: (
        id: string,
        observation: unknown,
        claimToken?: string,
      ) => unknown;
    });
});

after(() => {
  for (const server of [
    jellyfinServer,
    whisparrServer,
    tpdbServer,
    otherServer,
    stashdbServer,
  ]) {
    server.closeAllConnections?.();
    server.close();
  }
  closeStorage();
});

test("public surface: health, status, unknown routes", async () => {
  const health = await call("GET", "/api/health");
  assert.deepEqual(await health.json(), { ok: true });

  const status = await call("GET", "/api/status");
  assert.deepEqual(await status.json(), {
    initialized: false,
    setupReady: true,
  });

  const unknown = await call("GET", "/api/nope");
  assert.equal(unknown.status, 404);
  assert.ok(((await unknown.json()) as { error: object }).error);

  const wrongMethod = await call("GET", "/api/login");
  assert.equal(wrongMethod.status, 404);

  const traversal = await call("GET", "/api/library/../../status");
  assert.notEqual(traversal.status, 200);
});

test("mutations are origin protected (CSRF)", async () => {
  const missing = await call("POST", "/api/setup/inspect", {
    origin: null,
    body: {},
  });
  await errorShape(missing, 403);
  const foreign = await call("POST", "/api/setup/inspect", {
    origin: "https://evil.example",
    body: {},
  });
  await errorShape(foreign, 403);
  const setupForeign = await call("POST", "/api/setup", {
    origin: "https://evil.example",
    body: {},
  });
  await errorShape(setupForeign, 403);
  const loginForeign = await call("POST", "/api/login", {
    origin: "https://evil.example",
    body: {},
  });
  await errorShape(loginForeign, 403);
});

const inspectBody = () => ({
  setupSecret: process.env.VELVARR_SETUP_SECRET,
  username: "owner",
  password: "pass-owner",
  jellyfinUrl,
  jellyfinExternalUrl: jellyfinUrl,
  jellyfinApiKey: fx.adminKey,
});

test("setup inspect validates secret, authenticates, returns real selection", async () => {
  const badSecret = await call("POST", "/api/setup/inspect", {
    body: {
      ...inspectBody(),
      setupSecret: "wrong-secret-wrong-secret-wrong-secret!",
    },
  });
  await errorShape(badSecret);

  const unknownUser = await call("POST", "/api/setup/inspect", {
    body: { ...inspectBody(), username: "ghost", password: "pass-ghost" },
  });
  await errorShape(unknownUser);

  const ok = await call("POST", "/api/setup/inspect", { body: inspectBody() });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as {
    user: { id: string; name: string };
    libraries: { id: string }[];
  };
  assert.deepEqual(body.user, { id: OWNER_ID, name: "owner" });
  assert.deepEqual(
    body.libraries.map((lib) => lib.id).sort(),
    [MOVIES_LIB, SHOWS_LIB].sort(),
  );
  assert.equal(ok.headers.get("set-cookie"), null);
  assert.equal(JSON.stringify(body).includes("pass-owner"), false);
  assert.equal(JSON.stringify(body).includes(fx.adminKey), false);
});

test("setup commit is atomic, one-time, and race cannot overwrite config", async () => {
  const missingLibs = await call("POST", "/api/setup", {
    body: { ...inspectBody(), libraryIds: [] },
  });
  await errorShape(missingLibs);

  const unknownLib = await call("POST", "/api/setup", {
    body: { ...inspectBody(), libraryIds: ["9".repeat(32)] },
  });
  await errorShape(unknownLib);

  const whisparrNoKey = await call("POST", "/api/setup", {
    body: {
      ...inspectBody(),
      libraryIds: [MOVIES_LIB],
      whisparrUrl: whisparrUrl,
    },
  });
  await errorShape(whisparrNoKey);

  const stillFresh = await call("GET", "/api/status");
  assert.equal(
    ((await stillFresh.json()) as { initialized: boolean }).initialized,
    false,
  );

  const ok = await call("POST", "/api/setup", {
    body: { ...inspectBody(), libraryIds: [MOVIES_LIB, SHOWS_LIB] },
  });
  assert.equal(ok.status, 200);
  owner = cookieOf(ok);
  assert.match(owner, /^velvarr_session=/);
  const account = (await ok.json()) as {
    account: { id: string; isOwner: boolean; role: string; enabled: boolean };
  };
  assert.deepEqual(
    {
      id: account.account.id,
      isOwner: account.account.isOwner,
      role: account.account.role,
      enabled: account.account.enabled,
    },
    { id: OWNER_ID, isOwner: true, role: "admin", enabled: true },
  );

  const afterInit = await call("GET", "/api/status");
  assert.deepEqual(await afterInit.json(), {
    initialized: true,
    setupReady: true,
  });

  // Wrong setup race: a competing commit after initialization must fail without touching config.
  const race = await call("POST", "/api/setup", {
    body: {
      ...inspectBody(),
      username: "member2",
      password: "pass-member2",
      libraryIds: [SHOWS_LIB],
    },
  });
  await errorShape(race, 409);
  assert.equal(cookieOf(race), "");

  const integrations = await call("GET", "/api/admin/integrations", {
    cookie: owner,
  });
  const shape = (await integrations.json()) as {
    jellyfin: { url: string; serverId: string; apiKeyConfigured: boolean };
  };
  assert.equal(shape.jellyfin.url, jellyfinUrl);
  assert.equal(shape.jellyfin.serverId, SERVER_ID);
  assert.equal(shape.jellyfin.apiKeyConfigured, true);
  assert.equal(JSON.stringify(shape).includes(fx.adminKey), false);
});

test("session requirement and honest provider status", async () => {
  const anon = await call("GET", "/api/me");
  assert.equal(anon.status, 401);

  const garbage = await call("GET", "/api/me", {
    cookie: "velvarr_session=nonsense",
  });
  assert.equal(garbage.status, 401);

  const me = await call("GET", "/api/me", { cookie: owner });
  assert.equal(me.status, 200);
  const body = (await me.json()) as {
    account: { name: string; isOwner: boolean };
    providers: Record<string, string>;
  };
  assert.equal(body.account.name, "owner");
  assert.equal(body.account.isOwner, true);
  assert.deepEqual(body.providers, {
    tpdb: "not_configured",
    stashdb: "not_configured",
  });
});

test("admin import creates disabled grantless accounts; privilege boundary holds", async () => {
  const anon = await call("GET", "/api/admin/users");
  assert.equal(anon.status, 401);

  const imported = await call("POST", "/api/admin/users/import", {
    cookie: owner,
  });
  assert.equal(imported.status, 200);
  const body = (await imported.json()) as {
    accounts: {
      id: string;
      enabled: boolean;
      libraryIds: string[];
      role: string;
    }[];
  };
  assert.ok(body.accounts.length >= 5);
  for (const account of body.accounts) {
    if (account.id !== OWNER_ID) {
      assert.equal(account.enabled, false);
      assert.deepEqual(account.libraryIds, []);
      assert.equal(account.role, "requester");
    }
  }
  assert.equal(JSON.stringify(body).includes(fx.adminKey), false);

  // Re-import must not re-enable or duplicate.
  await call("POST", "/api/admin/users/import", { cookie: owner });
  const listed = await call("GET", "/api/admin/users", { cookie: owner });
  const listedBody = (await listed.json()) as {
    accounts: { id: string; enabled: boolean }[];
    libraries: { id: string }[];
  };
  assert.equal(listedBody.accounts.length, fx.users.length);
  assert.deepEqual(
    listedBody.libraries.map((lib) => lib.id).sort(),
    [MOVIES_LIB, SHOWS_LIB].sort(),
  );
  assert.equal(
    listedBody.accounts.find((account) => account.id === MEMBER_ID)?.enabled,
    false,
  );

  // Login while locally disabled is denied.
  const disabledLogin = await call("POST", "/api/login", {
    body: { username: "member", password: "pass-member" },
  });
  await errorShape(disabledLogin, 403);

  // Grant member the Movies library and enable.
  fx.grants.set(MEMBER_ID, [MOVIES_LIB]);
  const patched = await call("PATCH", `/api/admin/users/${MEMBER_ID}`, {
    cookie: owner,
    body: { enabled: true, role: "requester", libraryIds: [MOVIES_LIB] },
  });
  assert.equal(patched.status, 200);
  assert.equal(
    ((await patched.json()) as { account: { enabled: boolean } }).account
      .enabled,
    true,
  );

  // Owner protection.
  const disableOwner = await call("PATCH", `/api/admin/users/${OWNER_ID}`, {
    cookie: owner,
    body: { enabled: false, role: "admin", libraryIds: [] },
  });
  await errorShape(disableOwner, 403);
  const demoteOwner = await call("PATCH", `/api/admin/users/${OWNER_ID}`, {
    cookie: owner,
    body: { enabled: true, role: "moderator", libraryIds: [] },
  });
  await errorShape(demoteOwner, 403);
  const badLibrary = await call("PATCH", `/api/admin/users/${MEMBER_ID}`, {
    cookie: owner,
    body: { enabled: true, role: "requester", libraryIds: ["9".repeat(32)] },
  });
  await errorShape(badLibrary);
  member = await loginAs("member");
  const memberAdmin = await call("GET", "/api/admin/users", { cookie: member });
  await errorShape(memberAdmin, 403);
  const memberImport = await call("POST", "/api/admin/users/import", {
    cookie: member,
  });
  await errorShape(memberImport, 403);
  const memberEscalate = await call("PATCH", `/api/admin/users/${MEMBER_ID}`, {
    cookie: member,
    body: { enabled: true, role: "admin", libraryIds: [MOVIES_LIB, SHOWS_LIB] },
  });
  await errorShape(memberEscalate, 403);
  const memberIntegrations = await call("PATCH", "/api/admin/integrations", {
    cookie: member,
    body: {
      jellyfinUrl,
      jellyfinExternalUrl: jellyfinUrl,
    },
  });
  await errorShape(memberIntegrations, 403);
  const memberWhisparr = await call("GET", "/api/admin/whisparr", {
    cookie: member,
  });
  await errorShape(memberWhisparr, 403);
  const memberJellyfin = await call("GET", "/api/admin/jellyfin", {
    cookie: member,
  });
  await errorShape(memberJellyfin, 403);
});

test("request and body validation bounds", async () => {
  for (const query of [
    "limit=61",
    "limit=0",
    "limit=abc",
    "start=-1",
    `search=${"x".repeat(201)}`,
    "start=100001",
  ]) {
    const res = await call("GET", `/api/library?${query}`, { cookie: member });
    await errorShape(res);
  }
  const huge = await call("POST", "/api/login", {
    body: { username: "x".repeat(40000), password: "y" },
  });
  await errorShape(huge, 413);
  const badId = await call("GET", "/api/images/not-an-id", { cookie: member });
  await errorShape(badId);
  const traversalId = await call("GET", "/api/library/zzzz", {
    cookie: member,
  });
  await errorShape(traversalId);
});

test("library access is bounded by grants; no path leakage; protected images", async () => {
  const libs = await call("GET", "/api/libraries", { cookie: member });
  const libsBody = (await libs.json()) as { libraries: { id: string }[] };
  assert.deepEqual(
    libsBody.libraries.map((lib) => lib.id),
    [MOVIES_LIB],
  );

  const page = await call("GET", "/api/library", { cookie: member });
  assert.equal(page.status, 200);
  const pageBody = (await page.json()) as {
    items: { id: string }[];
    total: number;
  };
  assert.deepEqual(
    pageBody.items.map((item) => item.id),
    [ITEM_MOVIE],
  );
  assert.equal(pageBody.total, 1);

  const deniedLib = await call("GET", `/api/library?libraryId=${SHOWS_LIB}`, {
    cookie: member,
  });
  await errorShape(deniedLib, 403);

  const grantedLib = await call("GET", `/api/library?libraryId=${MOVIES_LIB}`, {
    cookie: member,
  });
  assert.equal(grantedLib.status, 200);

  const search = await call("GET", "/api/library?search=alpha", {
    cookie: member,
  });
  assert.equal(((await search.json()) as { total: number }).total, 1);

  const deniedItem = await call("GET", `/api/library/${ITEM_SHOW}`, {
    cookie: member,
  });
  // Denied must be an explicit error, never an empty success.
  await errorShape(deniedItem, 403);

  const item = await call("GET", `/api/library/${ITEM_MOVIE}`, {
    cookie: member,
  });
  assert.equal(item.status, 200);
  const itemText = await item.text();
  assert.equal(
    itemText.includes("/media/"),
    false,
    "server paths must never reach the browser",
  );
  assert.ok((JSON.parse(itemText) as { item: { name: string } }).item.name);

  const image = await call("GET", `/api/images/${ITEM_MOVIE}`, {
    cookie: member,
  });
  assert.equal(image.status, 200);
  assert.match(image.headers.get("content-type") ?? "", /^image\//);
  // Cacheable per URL with ETag revalidation — the pop-in fix. Private, so
  // no shared cache ever holds authenticated artwork.
  assert.match(image.headers.get("cache-control") ?? "", /max-age=\d+/);
  assert.match(image.headers.get("etag") ?? "", /^"/);
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.ok((await image.arrayBuffer()).byteLength > 0);

  const deniedImage = await call("GET", `/api/images/${ITEM_SHOW}`, {
    cookie: member,
  });
  await errorShape(deniedImage, 403);

  const anonImage = await call("GET", `/api/images/${ITEM_MOVIE}`);
  assert.equal(anonImage.status, 401);
});

test("empty grant list never means all libraries", async () => {
  fx.grants.set(NOGRANT_ID, []);
  const enabled = await call("PATCH", `/api/admin/users/${NOGRANT_ID}`, {
    cookie: owner,
    body: { enabled: true, role: "requester", libraryIds: [] },
  });
  assert.equal(enabled.status, 200);
  const cookie = await loginAs("nogrants");

  fx.fail.items = 9;
  const page = await call("GET", "/api/library", { cookie });
  assert.equal(page.status, 200);
  assert.deepEqual(await page.json(), {
    items: [],
    total: 0,
    start: 0,
    limit: 24,
  });
  const libs = await call("GET", "/api/libraries", { cookie });
  assert.deepEqual(await libs.json(), { libraries: [] });
});

test("outages are errors, never empty successes; transient failures keep sessions", async () => {
  fx.fail.views = 2; // one failure per call: both owner and member must see the outage
  const libsFail = await call("GET", "/api/libraries", { cookie: owner });
  await errorShape(libsFail, 500);
  const memberLibsFail = await call("GET", "/api/libraries", {
    cookie: member,
  });
  await errorShape(memberLibsFail, 500);

  fx.fail.items = 1;
  const pageFail = await call("GET", "/api/library", { cookie: member });
  await errorShape(pageFail, 500);

  // Session must survive transient upstream failure.
  fx.fail.me401 = 0;
  const stillIn = await call("GET", "/api/me", { cookie: member });
  assert.equal(stillIn.status, 200);

  // Unconfigured whisparr reports honestly as configured:false, not an outage.
  const whisparr = await call("GET", "/api/admin/whisparr", { cookie: owner });
  assert.equal(whisparr.status, 200);
  assert.equal(
    ((await whisparr.json()) as { configured: boolean }).configured,
    false,
  );
});

test("identity regressions: foreign identity, upstream invalidation, remote denial", async () => {
  const enable = await call("PATCH", `/api/admin/users/${MEMBER2_ID}`, {
    cookie: owner,
    // The Shows grant is member2's standing library access: the discover
    // outage test below proves a TPDB outage never starves the Jellyfin
    // rail, which needs at least one granted library to render items.
    body: { enabled: true, role: "requester", libraryIds: [SHOWS_LIB] },
  });
  assert.equal(enable.status, 200);
  let cookie = await loginAs("member2");

  // Remote-disabled upstream account is rejected.
  const fxMember2 = fx.users.find((user) => user.id === MEMBER2_ID)!;
  fxMember2.remote = false;
  const remote = await call("GET", "/api/me", { cookie });
  assert.equal(remote.status, 403);
  fxMember2.remote = true;
  // Permission denial does not revoke: still signed in after policy restored.
  assert.equal((await call("GET", "/api/me", { cookie })).status, 200);

  // Upstream identity swap (stolen token mapping to a different user) revokes.
  fx.impersonate = OUTSIDER_ID;
  assert.equal((await call("GET", "/api/me", { cookie })).status, 401);
  fx.impersonate = null;
  assert.equal(
    (await call("GET", "/api/me", { cookie })).status,
    401,
    "revocation must persist",
  );

  cookie = await loginAs("member2");

  // Proven upstream 401 invalidates the stored token.
  fx.fail.me401 = 1;
  assert.equal((await call("GET", "/api/me", { cookie })).status, 401);
  cookie = await loginAs("member2");

  // Upstream disabled account: rejected and session revoked.
  fxMember2.disabled = true;
  assert.equal((await call("GET", "/api/me", { cookie })).status, 403);
  fxMember2.disabled = false;
  assert.equal(
    (await call("GET", "/api/me", { cookie })).status,
    401,
    "disabled identity must revoke session",
  );
  cookie = await loginAs("member2");
  assert.equal((await call("GET", "/api/me", { cookie })).status, 200);
  // The rotation proofs above spent four of the five login attempts the
  // limiter allows for this account; the request and Wave A follow tests
  // below share this live session instead of logging in again.
  member2 = cookie;
});

test("integration rotation: no re-auth, pinned server, whisparr add/remove", async () => {
  // Same server, new external URL: allowed, grants preserved.
  const external = `${jellyfinUrl}/media`;
  const rotated = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: {
      jellyfinUrl,
      jellyfinExternalUrl: external,
      jellyfinApiKey: "",
    },
  });
  assert.equal(rotated.status, 200);
  const rotatedBody = (await rotated.json()) as {
    jellyfin: { externalUrl: string; libraryIds: string[] };
  };
  assert.equal(rotatedBody.jellyfin.externalUrl, external);
  assert.deepEqual(
    rotatedBody.jellyfin.libraryIds.sort(),
    [MOVIES_LIB, SHOWS_LIB].sort(),
  );

  // Different server identity rejected.
  const other = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: {
      jellyfinUrl: otherServerUrl,
      jellyfinExternalUrl: otherServerUrl,
    },
  });
  await errorShape(other);

  // Member grants survive rotation.
  const memberLibs = await call("GET", "/api/libraries", { cookie: member });
  assert.deepEqual(
    (
      (await memberLibs.json()) as { libraries: { id: string }[] }
    ).libraries.map((lib) => lib.id),
    [MOVIES_LIB],
  );

  // Whisparr: add, preserve on omission, remove explicitly.
  // Regression: saving Whisparr credentials must not re-authenticate the
  // admin. The old password confirmation logged in again under Velvarr's
  // shared DeviceId, which invalidated this session's own Jellyfin token and
  // signed the admin out on save.
  fx.journal.length = 0;
  fx.journalOn = true;
  const addWhisparr = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: {
      jellyfinUrl,
      jellyfinExternalUrl: external,
      whisparrUrl,
      whisparrApiKey: whisparrKey,
    },
  });
  fx.journalOn = false;
  assert.equal(addWhisparr.status, 200);
  assert.deepEqual(
    fx.journal.filter((r) => r.path === "/Users/AuthenticateByName"),
    [],
    "saving integrations must not re-authenticate the admin",
  );
  assert.equal(
    (await call("GET", "/api/me", { cookie: owner })).status,
    200,
    "the admin session must survive saving integrations",
  );

  const status = await call("GET", "/api/admin/whisparr", { cookie: owner });
  assert.equal(status.status, 200);
  const statusBody = (await status.json()) as {
    configured: boolean;
    version?: string;
    rootFolders?: unknown[];
  };
  assert.equal(statusBody.configured, true);
  assert.equal(statusBody.version, "3.4.0.1387");
  assert.ok(Array.isArray(statusBody.rootFolders));

  // The Jellyfin twin probe: saved URL + admin key, honestly verified.
  const jellyfinStatus = await call("GET", "/api/admin/jellyfin", {
    cookie: owner,
  });
  assert.equal(jellyfinStatus.status, 200);
  const jellyfinBody = (await jellyfinStatus.json()) as {
    configured: boolean;
    serverName?: string;
    version?: string;
  };
  assert.equal(jellyfinBody.configured, true);
  assert.equal(jellyfinBody.serverName, "FixtureJF");
  assert.equal(jellyfinBody.version, "10.9.0");

  const omit = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: {
      jellyfinUrl,
      jellyfinExternalUrl: external,
    },
  });
  assert.equal(omit.status, 200);
  const preserved = await call("GET", "/api/admin/whisparr", { cookie: owner });
  assert.equal(
    ((await preserved.json()) as { configured: boolean }).configured,
    true,
  );

  // A key without a URL is contradictory: the URL is the connection. Blank
  // URL alone removes Whisparr; key + blank URL is rejected, never dropped.
  const keyNoUrl = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: {
      jellyfinUrl,
      jellyfinExternalUrl: external,
      whisparrUrl: "",
      whisparrApiKey: whisparrKey,
    },
  });
  await errorShape(keyNoUrl, 400);
  const stillThere = await call("GET", "/api/admin/whisparr", {
    cookie: owner,
  });
  assert.equal(
    ((await stillThere.json()) as { configured: boolean }).configured,
    true,
  );

  const remove = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: {
      jellyfinUrl,
      jellyfinExternalUrl: external,
      whisparrUrl: "",
    },
  });
  assert.equal(remove.status, 200);
  const gone = await call("GET", "/api/admin/whisparr", { cookie: owner });
  assert.equal(
    ((await gone.json()) as { configured: boolean }).configured,
    false,
  );
});

test("login admission: outsider denied, logout revokes immediately", async () => {
  const outsider = await call("POST", "/api/login", {
    body: { username: "outsider", password: "pass-outsider" },
  });
  await errorShape(outsider, 403);

  const foreign = await call("POST", "/api/logout", {
    origin: "https://evil.example",
    cookie: member,
  });
  await errorShape(foreign, 403);
  assert.equal((await call("GET", "/api/me", { cookie: member })).status, 200);

  const out = await call("POST", "/api/logout", { cookie: member, body: {} });
  assert.equal(out.status, 200);
  assert.deepEqual(await out.json(), { ok: true });
  assert.match(out.headers.get("set-cookie") ?? "", /velvarr_session=/);
  assert.equal((await call("GET", "/api/me", { cookie: member })).status, 401);
});

// --- M2 phase 3: catalog, requests, availability ---
test("catalog search: auth, filter combos, honest totals, outage honesty", async () => {
  const anon = await call(
    "GET",
    "/api/catalog/search?provider=tpdb&kind=movie",
  );
  assert.equal(anon.status, 401);

  // member's session was revoked by the logout test; re-establish it once
  // for the whole M2 block.
  member = await loginAs("member");

  // Providers read credentials and base at call time; point them at the fixture.
  process.env.TPDB_API_TOKEN = tpdbToken;
  process.env.TPDB_BASE_URL = tpdbUrl;

  // Fake-capped TPDB total: totalCountKnown false, no total leaked.
  const unfiltered = await call(
    "GET",
    "/api/catalog/search?provider=tpdb&kind=movie",
    {
      cookie: member,
    },
  );
  assert.equal(unfiltered.status, 200);
  const page = (await unfiltered.json()) as {
    totalCountKnown: boolean;
    total?: number;
    hasMore: boolean;
    items: { reference: { provider: string; kind: string; id: string } }[];
  };
  assert.equal(page.totalCountKnown, false);
  assert.equal(page.total, undefined);
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.items[0]?.reference, {
    provider: "tpdb",
    kind: "movie",
    id: TPDB_MOVIE,
  });

  // Countable filter: real total passes through honestly.
  const filtered = await call(
    "GET",
    "/api/catalog/search?provider=tpdb&kind=movie&q=Fixture",
    { cookie: member },
  );
  const filteredBody = (await filtered.json()) as {
    totalCountKnown: boolean;
    total?: number;
  };
  assert.equal(filteredBody.totalCountKnown, true);
  assert.equal(filteredBody.total, 1);

  // Unsupported provider+kind+filter combinations: explicit errors, never
  // silent ignores.
  for (const query of [
    "provider=stashdb&kind=movie",
    "provider=stashdb&kind=scene&year=2020",
    "provider=tpdb&kind=movie&year=1800",
    "provider=tpdb&kind=performer",
    "provider=tpdb&kind=performer&q=x&year=2020",
    `provider=tpdb&kind=performer&q=x&performer=${TPDB_PERFORMER}`,
    "provider=stashdb&kind=performer&q=x&page=2",
    "provider=stashdb&kind=scene&performer=",
    "provider=junk&kind=movie",
    "provider=tpdb&kind=movie&page=0",
    "provider=tpdb&kind=movie&perPage=101",
  ]) {
    const res = await call("GET", `/api/catalog/search?${query}`, {
      cookie: member,
    });
    await errorShape(res);
  }

  // Outage: an explicit error, never an empty result set. First-contact:
  // forget any cached read of this query so the outage actually surfaces.
  resetMetaCache();
  tpdbFx.fail = 1;
  const outage = await call(
    "GET",
    "/api/catalog/search?provider=tpdb&kind=movie",
    {
      cookie: member,
    },
  );
  const err = await errorShape(outage, 500);
  assert.equal(err.code, "upstream_unavailable");
});

test("catalog search refuses the tpdb scene pairing before any upstream call", async () => {
  // One metadata source per kind: scenes list from StashDB only, so the
  // pairing itself is the error — not a filter, not an empty page.
  const refused = await call(
    "GET",
    "/api/catalog/search?provider=tpdb&kind=scene",
    { cookie: member },
  );
  assert.equal((await errorShape(refused)).code, "invalid_search");
});

test("provider credentials: stored config wins over environment, clear falls back", async () => {
  // The owner session from bootstrap is still valid; a fresh login would
  // burn the shared login rate-limit bucket late in the suite.
  const admin = owner;

  // Environment-configured baseline: the shape reports the environment.
  const before = await call("GET", "/api/admin/integrations", {
    cookie: admin,
  });
  assert.equal(before.status, 200);
  const beforeShape = (await before.json()) as {
    providers: { tpdb: { configured: boolean; source: string } };
  };
  assert.deepEqual(beforeShape.providers.tpdb, {
    configured: true,
    source: "environment",
  });

  // Storing a WRONG key flips the live check from "not configured" to an
  // auth failure — proof the stored key is used, not the environment one.
  const stored = await call("PATCH", "/api/admin/integrations", {
    cookie: admin,
    body: {
      tpdbApiToken: "wrong-stored-token",
    },
  });
  assert.equal(stored.status, 200);
  const storedShape = (await stored.json()) as {
    providers: { tpdb: { configured: boolean; source: string } };
  };
  assert.deepEqual(storedShape.providers.tpdb, {
    configured: true,
    source: "stored",
  });
  const rejected = await call("GET", "/api/admin/providers", { cookie: admin });
  assert.equal(rejected.status, 401);
  const rejectedBody = (await rejected.json()) as { error: { code: string } };
  assert.equal(rejectedBody.error.code, "upstream_auth");

  // Storing the working key verifies against the provider.
  const good = await call("PATCH", "/api/admin/integrations", {
    cookie: admin,
    body: {
      tpdbApiToken: tpdbToken,
    },
  });
  assert.equal(good.status, 200);
  const liveGood = await call("GET", "/api/admin/providers", { cookie: admin });
  assert.equal(liveGood.status, 200);
  const rows = (await liveGood.json()) as {
    providers: { provider: string; configured: boolean; account?: string }[];
  };
  const tpdbRow = rows.providers.find((r) => r.provider === "tpdb");
  assert.equal(tpdbRow?.configured, true);
  assert.equal(tpdbRow?.account, "Fixture TPDB");

  // Clearing the stored key falls back to the environment.
  const cleared = await call("PATCH", "/api/admin/integrations", {
    cookie: admin,
    body: {
      tpdbApiToken: "",
    },
  });
  assert.equal(cleared.status, 200);
  const clearedShape = (await cleared.json()) as {
    providers: {
      tpdb: { configured: boolean; source: string };
      typesafe: { configured: boolean; source: string };
    };
  };
  assert.deepEqual(clearedShape.providers.tpdb, {
    configured: true,
    source: "environment",
  });

  // The TypeSafe key rides the same stored-credentials path, but there is
  // no live-check endpoint: the shape is the only observable, and the
  // judgment features turn on and off with it.
  const tsStored = await call("PATCH", "/api/admin/integrations", {
    cookie: admin,
    body: { typesafeApiKey: "ts_test_stored" },
  });
  assert.equal(tsStored.status, 200);
  const tsStoredShape = (await tsStored.json()) as {
    providers: { typesafe: { configured: boolean; source: string } };
  };
  assert.deepEqual(tsStoredShape.providers.typesafe, {
    configured: true,
    source: "stored",
  });
  const tsCleared = await call("PATCH", "/api/admin/integrations", {
    cookie: admin,
    body: { typesafeApiKey: "" },
  });
  assert.equal(tsCleared.status, 200);
  const tsClearedShape = (await tsCleared.json()) as {
    providers: { typesafe: { configured: boolean; source: string } };
  };
  assert.deepEqual(tsClearedShape.providers.typesafe, {
    configured: Boolean(process.env.TYPESAFE_API_KEY),
    source: "environment",
  });
});

test("catalog detail: validation before upstream, absence vs outage, own request only", async () => {
  const anon = await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE}`);
  assert.equal(anon.status, 401);

  // Invalid provider/kind/UUID never reaches the provider.
  const callsBefore = tpdbFx.calls;
  await errorShape(
    await call("GET", "/api/catalog/tpdb/movie/not-a-uuid", { cookie: member }),
  );
  await errorShape(
    await call("GET", `/api/catalog/junk/movie/${TPDB_MOVIE}`, {
      cookie: member,
    }),
  );
  await errorShape(
    await call("GET", `/api/catalog/stashdb/movie/${TPDB_MOVIE}`, {
      cookie: member,
    }),
  );
  assert.equal(tpdbFx.calls, callsBefore);

  const detail = await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE}`, {
    cookie: member,
  });
  assert.equal(detail.status, 200);
  const body = (await detail.json()) as {
    detail: { reference: { id: string }; title: string };
    link: { unlinkedReason?: string };
    catalogRecord: { id: string; reference: { id: string } };
    myRequest: { decision: string } | null;
    acquisition: { state: string } | null;
  };
  assert.equal(body.detail.reference.id, TPDB_MOVIE);
  assert.equal(body.detail.title.length > 0, true);
  // Media is never linked across providers; the reason is explicit.
  assert.equal(typeof body.link.unlinkedReason, "string");
  assert.ok(body.catalogRecord.id);
  assert.equal(body.catalogRecord.reference.id, TPDB_MOVIE);
  assert.equal(body.myRequest, null);
  assert.equal(body.acquisition, null);

  // Authoritative absence is 404 with a distinct code; outage is an error.
  const missing = await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE2}`, {
    cookie: member,
  });
  assert.equal(missing.status, 404);
  assert.equal(
    ((await missing.json()) as { error: { code: string } }).error.code,
    "catalog_not_found",
  );
  // First-contact outage: stale fallback must not mask it.
  resetMetaCache();
  tpdbFx.fail = 1;
  await errorShape(
    await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE}`, {
      cookie: member,
    }),
    500,
  );
});

test("catalog artwork proxy: provider-only, no credentials, cacheable with revalidation", async () => {
  const target = encodeURIComponent(`${tpdbUrl}/fixture-artwork.png`);
  const anon = await call("GET", `/api/catalog/image?url=${target}`);
  assert.equal(anon.status, 401);

  // Non-provider hosts and credential-bearing URLs are rejected before fetch.
  await errorShape(
    await call(
      "GET",
      `/api/catalog/image?url=${encodeURIComponent("https://evil.example/art.png")}`,
      { cookie: member },
    ),
  );
  await errorShape(
    await call(
      "GET",
      `/api/catalog/image?url=${encodeURIComponent(
        "https://user:pass@cdn.theporndb.net/art.png",
      )}`,
      { cookie: member },
    ),
  );
  await errorShape(await call("GET", "/api/catalog/image", { cookie: member }));
  assert.equal(tpdbFx.imageAuth, "unset");

  const ok = await call("GET", `/api/catalog/image?url=${target}`, {
    cookie: member,
  });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") ?? "", /^image\//);
  assert.equal(ok.headers.get("cache-control"), "private, max-age=604800");
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), PNG_1PX);
  const etag = ok.headers.get("etag");
  assert.match(etag ?? "", /^"/);
  // No Velvarr or provider credential reached the image host.
  assert.equal(tpdbFx.imageAuth, "");

  // A revalidation round trips to a body-less 304 instead of a refetch.
  const revalidate = await call("GET", `/api/catalog/image?url=${target}`, {
    cookie: member,
    headers: { "if-none-match": etag! },
  });
  assert.equal(revalidate.status, 304);
  assert.equal(revalidate.headers.get("etag"), etag);
  assert.equal((await revalidate.arrayBuffer()).byteLength, 0);

  // A changed representation (different ETag) refetches in full.
  const stale = await call("GET", `/api/catalog/image?url=${target}`, {
    cookie: member,
    headers: { "if-none-match": '"stale"' },
  });
  assert.equal(stale.status, 200);
  assert.deepEqual(new Uint8Array(await stale.arrayBuffer()), PNG_1PX);

  // Studio logos are SVG upstream: active content served inert. It arrives
  // script-less by policy, cannot be embedded, and is never a document.
  const logo = await call(
    "GET",
    `/api/catalog/image?url=${encodeURIComponent(`${tpdbUrl}/studio-logo.svg`)}`,
    { cookie: member },
  );
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/svg+xml");
  assert.equal(
    logo.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );
  assert.equal(logo.headers.get("content-disposition"), "attachment");
  assert.equal(logo.headers.get("x-content-type-options"), "nosniff");
});

test("requests: lifecycle, autoApprove, privacy, roles, origin", async () => {
  // Re-establish Whisparr (removed by the rotation test) with delivery settings.
  const readd = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: {
      jellyfinUrl,
      jellyfinExternalUrl: jellyfinUrl,
      whisparrUrl,
      whisparrApiKey: whisparrKey,
      delivery: {
        enabled: true,
        rootFolderPath: "/movies",
        qualityProfileId: 1,
        searchOnAdd: true,
      },
      pathMappings: [
        { whisparrPrefix: "/data/whisparr", jellyfinPrefix: "/media" },
      ],
    },
  });
  if (readd.status !== 200) console.error("READDBODY", await readd.text());
  assert.equal(readd.status, 200);
  const shape = (await readd.json()) as {
    whisparr: {
      delivery: { enabled: boolean; rootFolderPath: string } | null;
      pathMappings: { whisparrPrefix: string }[];
    };
  };
  assert.equal(shape.whisparr.delivery?.enabled, true);
  assert.equal(shape.whisparr.delivery?.rootFolderPath, "/movies");
  assert.deepEqual(shape.whisparr.pathMappings, [
    { whisparrPrefix: "/data/whisparr", jellyfinPrefix: "/media" },
  ]);

  // Delivery validation: enabled requires a root folder; ids must be positive.
  await errorShape(
    await call("PATCH", "/api/admin/integrations", {
      cookie: owner,
      body: {
        jellyfinUrl,
        jellyfinExternalUrl: jellyfinUrl,
        delivery: {
          enabled: true,
          rootFolderPath: "",
          qualityProfileId: 1,
          searchOnAdd: true,
        },
      },
    }),
  );
  await errorShape(
    await call("PATCH", "/api/admin/integrations", {
      cookie: owner,
      body: {
        jellyfinUrl,
        jellyfinExternalUrl: jellyfinUrl,
        delivery: {
          enabled: true,
          rootFolderPath: "/movies",
          qualityProfileId: 0,
          searchOnAdd: true,
        },
      },
    }),
  );

  // A path mapping needs both prefixes; an empty one is rejected by the
  // request layer (`invalid_field`) before the storage guard ever sees it.
  const badMapping = await errorShape(
    await call("PATCH", "/api/admin/integrations", {
      cookie: owner,
      body: {
        jellyfinUrl,
        jellyfinExternalUrl: jellyfinUrl,
        pathMappings: [{ whisparrPrefix: "", jellyfinPrefix: "/media" }],
      },
    }),
  );
  assert.equal(badMapping.code, "invalid_field");

  // Delivery settings cannot outlive the Whisparr connection they configure:
  // removing Whisparr in the same body that sets delivery is rejected, and
  // the stored delivery settings survive the rejection.
  await errorShape(
    await call("PATCH", "/api/admin/integrations", {
      cookie: owner,
      body: {
        jellyfinUrl,
        jellyfinExternalUrl: jellyfinUrl,
        whisparrUrl: "",
        delivery: {
          enabled: true,
          rootFolderPath: "/movies",
          qualityProfileId: 1,
          searchOnAdd: true,
        },
      },
    }),
  );
  const stillSet = await call("GET", "/api/admin/integrations", {
    cookie: owner,
  });
  const kept = (await stillSet.json()) as {
    whisparr: { delivery: { rootFolderPath: string } | null } | null;
  };
  assert.equal(kept.whisparr?.delivery?.rootFolderPath, "/movies");

  // Real provider verification on the admin surface; unconfigured stays honest.
  const providers = await call("GET", "/api/admin/providers", {
    cookie: owner,
  });
  assert.equal(providers.status, 200);
  const providersBody = (await providers.json()) as {
    providers: {
      provider: string;
      configured: boolean;
      verified?: boolean;
      account?: string;
    }[];
  };
  const tpdb = providersBody.providers.find((p) => p.provider === "tpdb");
  assert.equal(tpdb?.configured, true);
  assert.equal(tpdb?.verified, true);
  assert.equal(tpdb?.account, "Fixture TPDB");
  const stashdb = providersBody.providers.find((p) => p.provider === "stashdb");
  assert.equal(stashdb?.configured, false);
  assert.equal((await call("GET", "/api/admin/providers")).status, 401);

  // Unauthenticated and cross-origin mutations are rejected.
  const media = { provider: "tpdb", kind: "movie", id: TPDB_MOVIE };
  assert.equal(
    (await call("POST", "/api/requests", { body: { media } })).status,
    401,
  );
  await errorShape(
    await call("POST", "/api/requests", {
      origin: null,
      cookie: member,
      body: { media },
    }),
    403,
  );

  // Forged payloads: only the server-validated reference is stored.
  await errorShape(
    await call("POST", "/api/requests", {
      cookie: member,
      body: { media: { provider: "tpdb", kind: "movie", id: "not-a-uuid" } },
    }),
  );
  await errorShape(
    await call("POST", "/api/requests", {
      cookie: member,
      body: {
        media: { provider: "tpdb", kind: "performer", id: TPDB_PERFORMER },
      },
    }),
  );

  // Plain requester: 201 pending.
  const created = await call("POST", "/api/requests", {
    cookie: member,
    body: { media },
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as {
    request: { id: string; decision: string };
    autoApproved?: boolean;
  };
  assert.equal(createdBody.request.decision, "pending");
  assert.equal(createdBody.autoApproved, undefined);
  const memberRequestId = createdBody.request.id;

  // Duplicate active intent is an honest 409.
  const dup = await call("POST", "/api/requests", {
    cookie: member,
    body: { media },
  });
  assert.equal(dup.status, 409);
  assert.equal(
    ((await dup.json()) as { error: { code: string } }).error.code,
    "request_exists",
  );

  // Whisparr has no metadata source for a TPDB scene: refused at the click,
  // never filed as a request that can only fail in the worker.
  const undeliverable = await call("POST", "/api/requests", {
    cookie: member,
    body: {
      media: { provider: "tpdb", kind: "scene", id: TPDB_MOVIE2 },
    },
  });
  const undeliverableError = await errorShape(undeliverable, 400);
  assert.equal(undeliverable.status, 400);
  assert.equal(undeliverableError.code, "invalid_reference");

  // member2 (no grant yet): own request stays pending.
  const m2 = member2; // live session from the identity test above — no fresh login (limiter).
  const m2Created = await call("POST", "/api/requests", {
    cookie: m2,
    body: { media: { provider: "tpdb", kind: "movie", id: TPDB_MOVIE2 } },
  });
  assert.equal(m2Created.status, 201);
  const m2RequestId = ((await m2Created.json()) as { request: { id: string } })
    .request.id;

  // Role enforcement: requesters cannot decide, own or foreign.
  await errorShape(
    await call("PATCH", `/api/requests/${memberRequestId}`, {
      cookie: member,
      body: { decision: "approved" },
    }),
    403,
  );
  await errorShape(
    await call("PATCH", `/api/requests/${memberRequestId}`, {
      cookie: m2,
      body: { decision: "approved" },
    }),
    403,
  );

  // Privacy: member2 sees only their own list entry — and no requestedBy
  // echo of their own name (requester lists never carry it).
  const m2List = await call("GET", "/api/requests", { cookie: m2 });
  const m2Rows = (
    (await m2List.json()) as { requests: Record<string, unknown>[] }
  ).requests;
  assert.deepEqual(
    m2Rows.map((r) => r.id),
    [m2RequestId],
  );
  assert.ok(m2Rows.every((r) => !("requestedBy" in r)));
  // The owner (staff) sees all requests, with the requester's display name
  // attached to every row — including rows they did not create.
  const ownerRows = (
    (await (await call("GET", "/api/requests", { cookie: owner })).json()) as {
      requests: { id: string; requestedBy?: string }[];
    }
  ).requests;
  const ownerIds = ownerRows.map((r) => r.id);
  assert.ok(ownerIds.includes(memberRequestId));
  assert.ok(ownerIds.includes(m2RequestId));
  assert.equal(
    ownerRows.find((r) => r.id === memberRequestId)?.requestedBy,
    "member",
  );
  assert.equal(
    ownerRows.find((r) => r.id === m2RequestId)?.requestedBy,
    "member2",
  );

  // Detail: the caller's own decision only; no acquisition before approval.
  const detailForMember = await call(
    "GET",
    `/api/catalog/tpdb/movie/${TPDB_MOVIE}`,
    { cookie: member },
  );
  const detailMemberBody = (await detailForMember.json()) as {
    myRequest: { decision: string } | null;
    acquisition: { state: string } | null;
  };
  assert.equal(detailMemberBody.myRequest?.decision, "pending");
  assert.equal(detailMemberBody.acquisition, null);
  const detailForM2 = await call(
    "GET",
    `/api/catalog/tpdb/movie/${TPDB_MOVIE}`,
    { cookie: m2 },
  );
  assert.equal(
    ((await detailForM2.json()) as { myRequest: unknown }).myRequest,
    null,
  );

  // Owner approves: shared acquisition state visible to both viewers, while
  // myRequest stays per-user.
  const approve = await call("PATCH", `/api/requests/${memberRequestId}`, {
    cookie: owner,
    body: { decision: "approved" },
  });
  assert.equal(approve.status, 200);
  const afterBody = (await (
    await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE}`, {
      cookie: member,
    })
  ).json()) as {
    myRequest: { decision: string } | null;
    acquisition: { state: string } | null;
  };
  assert.equal(afterBody.myRequest?.decision, "approved");
  assert.equal(afterBody.acquisition?.state, "unsent");
  const sharedForM2 = (await (
    await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE}`, { cookie: m2 })
  ).json()) as { acquisition: { state: string } | null };
  assert.equal(sharedForM2.acquisition?.state, "unsent");

  // The requests LIST carries the shared acquisition state on approved rows
  // only: the requester can watch progress without another user's history.
  const listed = (await (
    await call("GET", "/api/requests", { cookie: member })
  ).json()) as {
    requests: {
      decision: string;
      acquisition: { state: string } | null;
    }[];
  };
  // Requester list: acquisition facts yes, requester names no.
  assert.ok(listed.requests.every((r) => !("requestedBy" in r)));
  const approvedRow = listed.requests.find((r) => r.decision === "approved");
  assert.equal(approvedRow?.acquisition?.state, "unsent");
  assert.ok(
    listed.requests
      .filter((r) => r.decision !== "approved")
      .every((r) => r.acquisition === null),
  );

  // Owner declines member2's pending request.
  const decline = await call("PATCH", `/api/requests/${m2RequestId}`, {
    cookie: owner,
    body: { decision: "declined" },
  });
  assert.equal(decline.status, 200);
  assert.equal(
    ((await decline.json()) as { request: { decision: string } }).request
      .decision,
    "declined",
  );

  // Cancel: own pending only; a foreign cancel is a bare 404 with no leak.
  const m2Second = await call("POST", "/api/requests", {
    cookie: m2,
    body: { media: { provider: "tpdb", kind: "movie", id: TPDB_MOVIE2 } },
  });
  assert.equal(m2Second.status, 201);
  const m2SecondId = ((await m2Second.json()) as { request: { id: string } })
    .request.id;
  const foreignCancel = await call("PATCH", `/api/requests/${m2SecondId}`, {
    cookie: member,
    body: { decision: "cancelled" },
  });
  assert.equal(foreignCancel.status, 404);
  assert.equal(
    ((await foreignCancel.json()) as { error: { code: string } }).error.code,
    "request_not_found",
  );
  assert.equal(
    (
      await call("PATCH", `/api/requests/${m2SecondId}`, {
        cookie: m2,
        body: { decision: "cancelled" },
      })
    ).status,
    200,
  );
  // Storage allows cancelling pending|approved; cancelling an already
  // cancelled request is the faithful 409.
  const cancelAgain = await call("PATCH", `/api/requests/${m2SecondId}`, {
    cookie: m2,
    body: { decision: "cancelled" },
  });
  assert.equal(cancelAgain.status, 409);
  assert.equal(
    ((await cancelAgain.json()) as { error: { code: string } }).error.code,
    "request_not_cancellable",
  );
  await errorShape(
    await call("PATCH", `/api/requests/${memberRequestId}`, {
      cookie: owner,
      body: { decision: "nope" },
    }),
  );
  assert.equal(
    (
      await call("PATCH", `/api/requests/${memberRequestId}`, {
        body: { decision: "approved" },
      })
    ).status,
    401,
  );
  await errorShape(
    await call("PATCH", `/api/requests/${memberRequestId}`, {
      origin: "https://evil.example",
      cookie: owner,
      body: { decision: "declined" },
    }),
    403,
  );
  // A terminal decision (decline, cancel) never blocks re-requesting: the
  // detail vacates the myRequest slot (button re-offered) and a fresh POST
  // creates a new pending row instead of 409. m2's TPDB_MOVIE request was
  // declined above; the provider fixture serves that movie's detail.
  const afterDecline = (await (
    await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE}`, { cookie: m2 })
  ).json()) as { myRequest: unknown };
  assert.equal(afterDecline.myRequest, null);
  const reRequest = await call("POST", "/api/requests", {
    cookie: m2,
    body: { media: { provider: "tpdb", kind: "movie", id: TPDB_MOVIE } },
  });
  assert.equal(reRequest.status, 201);
  assert.equal(
    ((await reRequest.json()) as { request: { decision: string } }).request
      .decision,
    "pending",
  );

  // autoApprove grant: the request auto-decides approved and enqueues work.
  // Uses the nogrants account: member2's login bucket is spent, and a grant
  // change revokes the target's sessions by design, so a fresh login is
  // part of the flow.
  const grant = await call("PATCH", `/api/admin/users/${NOGRANT_ID}`, {
    cookie: owner,
    body: {
      enabled: true,
      role: "requester",
      libraryIds: [],
      autoApprove: true,
    },
  });
  assert.equal(grant.status, 200);
  assert.equal(
    ((await grant.json()) as { account: { autoApprove: boolean } }).account
      .autoApprove,
    true,
  );
  // The autoApprove PATCH above revoked this account's earlier session by
  // design (any grant change drops sessions), so the login lives here and
  // every later nogrants call site reuses the cookie.
  const autoCookie = (nogrants = await loginAs("nogrants"));
  const auto = await call("POST", "/api/requests", {
    cookie: autoCookie,
    body: { media: { provider: "tpdb", kind: "movie", id: TPDB_MOVIE3 } },
  });
  assert.equal(auto.status, 201);
  const autoBody = (await auto.json()) as {
    request: { decision: string };
    autoApproved: boolean;
  };
  assert.equal(autoBody.autoApproved, true);
  assert.equal(autoBody.request.decision, "approved");
  assert.ok(
    getAcquisitionByReference({
      provider: "tpdb",
      kind: "movie",
      id: TPDB_MOVIE3,
    }),
  );
});

test("availability: distinct verdicts under the caller's own token", async () => {
  assert.equal(
    (await call("GET", `/api/availability/tpdb/movie/${TPDB_MOVIE}`)).status,
    401,
  );

  // Worker-equivalent: persist observed Whisparr facts on the shared
  // acquisition; the availability route must read them, never call Whisparr.
  const acq = getAcquisitionByReference({
    provider: "tpdb",
    kind: "movie",
    id: TPDB_MOVIE,
  });
  assert.ok(acq);
  recordAcquisitionObservation(acq.id, {
    state: "monitoring",
    item: {
      whisparrId: 77,
      path: `/media/${ITEM_MOVIE}.mkv`,
      title: "Alpha Movie",
    },
  });

  // available: exact path correspondence, granted library, playable source.
  const available = await call(
    "GET",
    `/api/availability/tpdb/movie/${TPDB_MOVIE}`,
    { cookie: member },
  );
  assert.equal(available.status, 200);
  const availableBody = (await available.json()) as {
    outcome: string;
    item?: { id: string };
  };
  assert.equal(availableBody.outcome, "available");
  assert.equal(availableBody.item?.id, ITEM_MOVIE);

  // denied: no granted libraries for this caller.
  fx.grants.set(NOGRANT_ID, []);
  const noGrantCookie = nogrants; // shared session from the autoApprove test above.
  const denied = await call(
    "GET",
    `/api/availability/tpdb/movie/${TPDB_MOVIE}`,
    { cookie: noGrantCookie },
  );
  assert.equal(
    ((await denied.json()) as { outcome: string }).outcome,
    "denied",
  );

  // ambiguous: title-only similarity is never upgraded to a guess.
  const acq3Req = await call("POST", "/api/requests", {
    cookie: member,
    body: { media: { provider: "tpdb", kind: "movie", id: TPDB_MOVIE3 } },
  });
  assert.equal(acq3Req.status, 201);
  const acq3Id = ((await acq3Req.json()) as { request: { id: string } }).request
    .id;
  await call("PATCH", `/api/requests/${acq3Id}`, {
    cookie: owner,
    body: { decision: "approved" },
  });
  const acq3 = getAcquisitionByReference({
    provider: "tpdb",
    kind: "movie",
    id: TPDB_MOVIE3,
  });
  assert.ok(acq3);
  recordAcquisitionObservation(acq3.id, {
    state: "monitoring",
    item: { title: "Alpha Movie" },
  });
  const ambiguous = await call(
    "GET",
    `/api/availability/tpdb/movie/${TPDB_MOVIE3}`,
    { cookie: member },
  );
  assert.equal(
    ((await ambiguous.json()) as { outcome: string }).outcome,
    "ambiguous",
  );

  // missing: known identity, nothing on the media server.
  const m4Req = await call("POST", "/api/requests", {
    cookie: member,
    body: { media: { provider: "tpdb", kind: "movie", id: TPDB_MOVIE4 } },
  });
  const m4Id = ((await m4Req.json()) as { request: { id: string } }).request.id;
  await call("PATCH", `/api/requests/${m4Id}`, {
    cookie: owner,
    body: { decision: "approved" },
  });
  const missing = await call(
    "GET",
    `/api/availability/tpdb/movie/${TPDB_MOVIE4}`,
    { cookie: member },
  );
  assert.equal(
    ((await missing.json()) as { outcome: string }).outcome,
    "missing",
  );

  // unavailable: an upstream failure is never reported as missing.
  fx.fail.items = 1;
  const unavailable = await call(
    "GET",
    `/api/availability/tpdb/movie/${TPDB_MOVIE4}`,
    { cookie: member },
  );
  assert.equal(
    ((await unavailable.json()) as { outcome: string }).outcome,
    "unavailable",
  );

  // Performers are not requestable/available media.
  await errorShape(
    await call("GET", `/api/availability/tpdb/performer/${TPDB_PERFORMER}`, {
      cookie: member,
    }),
  );
});

// --- M3 phase B: studio kind; browse params wired with explicit rejects ---
test("studio search per provider; studio references refused as media; unsupported combos 400", async () => {
  // Providers read credentials and base at call time; point StashDB at the
  // fixture. Runs after the admin/providers test, which pins stashdb as
  // unconfigured.
  process.env.STASHDB_API_KEY = stashdbKey;
  process.env.STASHDB_BASE_URL = stashdbUrl;

  // TPDB studio search (sites): q required, results are studio references.
  const tpdbStudio = await call(
    "GET",
    "/api/catalog/search?provider=tpdb&kind=studio&q=Fixture",
    { cookie: member },
  );
  assert.equal(tpdbStudio.status, 200);
  const tpdbStudioBody = (await tpdbStudio.json()) as {
    kind: string;
    items: { reference: { provider: string; kind: string; id: string } }[];
  };
  assert.equal(tpdbStudioBody.kind, "studio");
  assert.deepEqual(tpdbStudioBody.items[0]?.reference, {
    provider: "tpdb",
    kind: "studio",
    id: TPDB_STUDIO,
  });

  // StashDB studio search: unpaged, query-only.
  const stashStudio = await call(
    "GET",
    "/api/catalog/search?provider=stashdb&kind=studio&q=Fixture",
    { cookie: member },
  );
  assert.equal(stashStudio.status, 200);
  const stashStudioBody = (await stashStudio.json()) as {
    kind: string;
    page: number;
    items: { reference: { provider: string; kind: string; id: string } }[];
  };
  assert.equal(stashStudioBody.kind, "studio");
  assert.equal(stashStudioBody.page, 1);
  assert.deepEqual(stashStudioBody.items[0]?.reference, {
    provider: "stashdb",
    kind: "studio",
    id: STASH_STUDIO,
  });

  // Studio is browsable on the detail route (TPDB site detail)...
  const detail = await call("GET", `/api/catalog/tpdb/studio/${TPDB_STUDIO}`, {
    cookie: member,
  });
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as {
    detail: { reference: { kind: string; id: string }; title: string };
  };
  assert.equal(detailBody.detail.reference.kind, "studio");
  assert.equal(detailBody.detail.reference.id, TPDB_STUDIO);
  assert.equal(detailBody.detail.title.length > 0, true);

  // ...but a studio reference is never requestable or availability media.
  await errorShape(
    await call("POST", "/api/requests", {
      cookie: member,
      body: { media: { provider: "tpdb", kind: "studio", id: TPDB_STUDIO } },
    }),
  );
  await errorShape(
    await call("GET", `/api/availability/tpdb/studio/${TPDB_STUDIO}`, {
      cookie: member,
    }),
  );
  await errorShape(
    await call("POST", "/api/requests", {
      cookie: member,
      body: {
        media: { provider: "stashdb", kind: "studio", id: STASH_STUDIO },
      },
    }),
  );

  // Unsupported provider+kind+parameter combinations: explicit 400
  // invalid_query, never a silent ignore.
  const rejected = [
    `provider=tpdb&kind=movie&sort=popularity`,
    `provider=stashdb&kind=scene&sort=relevance`,
    `provider=tpdb&kind=movie&tagsExclude=${TAG_A}`,
    `provider=stashdb&kind=scene&tagsAll=${TAG_A}`,
    `provider=stashdb&kind=studio&q=x&page=2`,
    `provider=stashdb&kind=studio&q=x&perPage=10`,
    `provider=stashdb&kind=performer&q=x&sort=title`,
    `provider=tpdb&kind=studio&q=x&tags=${TAG_A}`,
    `provider=tpdb&kind=performer&q=x&sort=recency`,
    `provider=tpdb&kind=movie&sort=bogus`,
  ] as const;
  for (const query of rejected) {
    const res = await call("GET", `/api/catalog/search?${query}`, {
      cookie: member,
    });
    assert.equal(res.status, 400, query);
    assert.equal(
      ((await res.json()) as { error: { code: string } }).error.code,
      "invalid_query",
      query,
    );
  }

  // A supported sort wires through: the page reports the exact applied order.
  const sorted = await call(
    "GET",
    "/api/catalog/search?provider=tpdb&kind=movie&sort=recency&direction=asc",
    { cookie: member },
  );
  assert.equal(sorted.status, 200);
  assert.deepEqual(
    (
      (await sorted.json()) as {
        sort?: { key: string; direction: string; upstream: string };
      }
    ).sort,
    { key: "recency", direction: "asc", upstream: "former_released" },
  );

  // Repeatable and comma-separated tag lists both parse into one filter.
  const tagged = await call(
    "GET",
    `/api/catalog/search?provider=tpdb&kind=movie&tags=${TAG_A}&tags=${TAG_B}`,
    { cookie: member },
  );
  assert.equal(tagged.status, 200);
  const commaed = await call(
    "GET",
    `/api/catalog/search?provider=tpdb&kind=movie&tags=${TAG_A},${TAG_B}`,
    { cookie: member },
  );
  assert.equal(commaed.status, 200);
});

// --- M3 phase B: discover shelves + global multi-category search ---

// Response wire shapes for the endpoints under test. Named boundary casts:
// json() arrives untyped and no schema validator exists in this suite.
interface FixtureShelf {
  id: string;
  kind?: string;
  source?: string;
  description?: string;
  browse?: { view: string; params: Record<string, string> };
  items?: {
    id?: string;
    name?: string;
    imageUrl?: string;
    logoUrl?: string;
    facet?: string;
    provider?: string;
    accountId?: string;
    reference?: unknown;
    title?: string;
    linked?: { provider: string; id: string };
  }[];
  /** Per-source partial-failure evidence; coexists with items. */
  errors?: { provider: string; code: string; message: string }[];
  error?: { code: string };
}

// Facet tiles: projected to the pinned wire fields for set comparison.
type FacetTile = NonNullable<FixtureShelf["items"]>[number];

/** Reference-shaped read of a shelf item, narrowed with `in` checks — the
 * shared helper every shelf-membership assertion goes through. */
function refOf(
  item: FacetTile,
): { provider: string; kind: string; id: string } | null {
  const ref = item.reference;
  if (
    typeof ref === "object" &&
    ref !== null &&
    "provider" in ref &&
    "kind" in ref &&
    "id" in ref &&
    typeof ref.provider === "string" &&
    typeof ref.kind === "string" &&
    typeof ref.id === "string"
  ) {
    return { provider: ref.provider, kind: ref.kind, id: ref.id };
  }
  return null;
}

interface FixtureCategory {
  id: string;
  provider: string;
  kind: string;
  items: { reference: { provider: string; kind: string; id: string } }[];
  error?: { code: string };
}

async function shelvesOf(res: Response): Promise<FixtureShelf[]> {
  const body = (await res.json()) as { shelves: FixtureShelf[] };
  return body.shelves;
}

async function searchOf(res: Response): Promise<{
  query: string;
  categories: FixtureCategory[];
}> {
  return (await res.json()) as {
    query: string;
    categories: FixtureCategory[];
  };
}

test("discover: mixed new releases, honest trending, facets, grants, not-configured", async () => {
  assert.equal((await call("GET", "/api/discover")).status, 401);

  const ok = await call("GET", "/api/discover", { cookie: member });
  assert.equal(ok.status, 200);
  const shelves = await shelvesOf(ok);
  // Mixed new releases, trending, then library/requests, then the two
  // unified facet shelves. This account follows nobody, so no
  // followed-titles rail exists (proven below via /api/follows).
  assert.deepEqual(
    shelves.map((shelf) => shelf.id),
    [
      "new-releases",
      "trending",
      "jellyfin-recent",
      "velvarr-requests",
      "studios",
      "genres",
    ],
  );
  const byId = new Map(shelves.map((shelf) => [shelf.id, shelf]));
  const memberFollows = await call("GET", "/api/follows", { cookie: member });
  assert.equal(memberFollows.status, 200);
  // json() is untyped and the suite has no validator; named const, then read.
  const memberFollowsBody = (await memberFollows.json()) as {
    follows: unknown[];
  };
  assert.deepEqual(memberFollowsBody.follows, []);
  const newReleases = byId.get("new-releases");
  const trending = byId.get("trending");
  const library = byId.get("jellyfin-recent");
  const requests = byId.get("velvarr-requests");

  // Every shelf carries items; none fails silently.
  for (const shelf of shelves) {
    assert.equal(shelf.error, undefined, shelf.id);
    assert.ok((shelf.items?.length ?? 0) > 0, `${shelf.id} carries items`);
  }

  // New releases is genuinely mixed: TPDB movies and StashDB scenes in one
  // velvarr-sourced rail. Membership, not merge order, is the contract.
  assert.equal(newReleases?.source, "velvarr");
  const releaseRefs = (newReleases?.items ?? []).map(refOf);
  assert.ok(
    releaseRefs.some(
      (ref) => ref?.provider === "tpdb" && ref?.kind === "movie",
    ),
    "new releases carries a TPDB movie",
  );
  assert.ok(
    releaseRefs.some(
      (ref) => ref?.provider === "stashdb" && ref?.kind === "scene",
    ),
    "new releases carries a StashDB scene",
  );

  // Browse destinations mirror the shelf's actual upstream query, including
  // the release-date bound, so clicking through shows the same set.
  assert.deepEqual(newReleases?.browse?.view, "titles");
  const browseParams = newReleases?.browse?.params ?? {};
  assert.equal(browseParams.type, "all");
  assert.equal(browseParams.sort, "recency");
  assert.equal(browseParams.direction, "desc");
  assert.equal(browseParams.date_operation, "<=");
  assert.match(browseParams.date ?? "", /^\d{4}-\d{2}-\d{2}$/);

  // Trending is honestly a StashDB-only signal: labeled as such, described
  // as such, and its browse link goes to the unified scene browse.
  assert.equal(trending?.source, "stashdb");
  assert.equal(trending?.description, "Scene trends from StashDB");
  assert.deepEqual(trending?.browse, {
    view: "titles",
    params: { type: "scene", sort: "trending", direction: "desc" },
  });
  assert.deepEqual(trending?.items?.[0]?.reference, {
    provider: "stashdb",
    kind: "scene",
    id: STASH_SCENE,
  });

  // Unified facet shelves: one tile per studio/category across BOTH
  // providers, paired only through provider-published counterpart data.
  // No single browse destination exists, so the shelf carries no browse
  // key — each tile builds its own href.
  const studiosShelf = byId.get("studios");
  const genresShelf = byId.get("genres");
  for (const shelf of [studiosShelf, genresShelf]) {
    assert.equal(shelf?.kind, "facets", shelf?.id);
    assert.equal(shelf?.source, "velvarr", shelf?.id);
    // The headline arrows lead to the facet directory overview.
    assert.deepEqual(shelf?.browse, {
      view: "facets",
      params: { kind: shelf?.id },
    });
    assert.equal(shelf?.error, undefined, shelf?.id);
    assert.ok((shelf?.items?.length ?? 0) > 0, `${shelf?.id} carries items`);
  }
  // Projects each tile to the pinned wire fields and compares as an
  // id-sorted set, so provider-side enrichment (imageUrl/logoUrl) cannot
  // rotate the assertion and missing tiles cannot hide.
  const assertTileSet = (
    shelf: FixtureShelf | undefined,
    expected: {
      facet: string;
      provider: string;
      id: string;
      name: string;
      linked: { provider: string; id: string } | undefined;
    }[],
  ): void => {
    const actual = ((shelf?.items ?? []) as FacetTile[])
      .map(({ facet, provider, id, name, linked }) => ({
        facet,
        provider,
        id,
        name,
        linked,
      }))
      .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
    assert.deepEqual(actual, expected);
  };
  // Studios: a studio published on BOTH providers appears ONCE. The StashDB
  // tile survives (its record publishes the TPDB uuid URL, so it carries
  // `linked` → the TPDB id) and the TPDB-origin tile for that published id
  // is dropped — dedupe keys on the published id, never the shared name.
  // The linkless Second Studio is a genuinely distinct studio: it must still
  // render, so a dedupe that ever dropped studios with no published link
  // fails this set.
  assertTileSet(studiosShelf, [
    {
      facet: "studio",
      provider: "tpdb",
      id: TPDB_STUDIO2,
      name: "Second Studio",
      linked: undefined,
    },
    {
      facet: "studio",
      provider: "stashdb",
      id: STASH_STUDIO,
      name: "Fixture Studio",
      linked: { provider: "tpdb", id: TPDB_STUDIO },
    },
  ]);
  // Genres: only exact normalized-name equality pairs a tag — TAG_A meets
  // its stash twin "fixture-tag-a", while TAG_C's lookup answers only
  // near-misses and TAG_B's finds nothing on TPDB; all still render.
  assertTileSet(genresShelf, [
    {
      facet: "tag",
      provider: "tpdb",
      id: TAG_A,
      name: "Fixture Tag A",
      linked: { provider: "stashdb", id: TAG_D },
    },
    {
      facet: "tag",
      provider: "stashdb",
      id: TAG_B,
      name: "Fixture Stash Tag",
      linked: undefined,
    },
    {
      facet: "tag",
      provider: "tpdb",
      id: TAG_C,
      name: "Fixture Tag C",
      linked: undefined,
    },
  ]);
  // ponytail: the wire contract pins tiles, not merge order or the cap
  // value — set equality is the honest assert; pin sequence only if the
  // contract ever does.

  // Jellyfin shelf: granted libraries only — member holds just Movies.
  assert.deepEqual((library?.items ?? []).map((item) => item.id).sort(), [
    ITEM_MOVIE,
  ]);
  assert.equal(JSON.stringify(library).includes(ITEM_SHOW), false);

  // Requests shelf: storage role-filters; member (requester) sees own only.
  assert.ok((requests?.items?.length ?? 0) > 0);
  for (const record of requests?.items ?? []) {
    assert.equal(record.accountId, MEMBER_ID);
  }

  // One source failing: the mixed rail keeps the survivor's titles beside a
  // visible per-source warning — a degraded page, never an error page and
  // never a quiet success. First-contact: the earlier discover cached these
  // shelves.
  resetMetaCache();
  tpdbFx.fail = 1;
  const outage = await call("GET", "/api/discover", { cookie: member });
  assert.equal(outage.status, 200, "shelf failure must not fail the page");
  const outById = new Map(
    (await shelvesOf(outage)).map((shelf) => [shelf.id, shelf]),
  );
  const outNew = outById.get("new-releases");
  assert.equal(outNew?.error, undefined, "partial failure is not an error");
  assert.ok((outNew?.items?.length ?? 0) > 0, "survivor side still renders");
  for (const item of outNew?.items ?? []) {
    assert.equal(refOf(item)?.provider, "stashdb", "survivor side only");
  }
  assert.equal(outNew?.errors?.length, 1);
  assert.equal(outNew?.errors?.[0]?.provider, "tpdb");
  assert.match(outNew?.errors?.[0]?.code ?? "", /unavailable/);
  for (const id of ["trending", "jellyfin-recent", "velvarr-requests"]) {
    const shelf = outById.get(id);
    assert.equal(shelf?.error, undefined, id);
    assert.ok((shelf?.items?.length ?? 0) > 0, id);
  }
  for (const id of ["studios", "genres"]) {
    const shelf = outById.get(id);
    assert.equal(shelf?.error, undefined, id);
    // With the TPDB side down, every surviving tile is stash-side.
    for (const tile of (shelf?.items ?? []) as FacetTile[]) {
      assert.equal(tile.provider, "stashdb", `${id}:${tile.id}`);
    }
  }

  // Both sources failing: the mixed rail collapses to an error shelf, the
  // single-source trending shelf reports its own outage, and the facet
  // rails carry one error each with no items — never a half-filled rail
  // that could read as a quiet success. Fail deep rather than counting
  // calls: a page is truly source-less only when every read on both sides
  // dies, however many each side legitimately issues.
  resetMetaCache();
  tpdbFx.fail = 5;
  stashdbFx.fail = 5;
  try {
    const bothDown = await call("GET", "/api/discover", { cookie: member });
    assert.equal(bothDown.status, 200, "shelf failure must not fail the page");
    const bothById = new Map(
      (await shelvesOf(bothDown)).map((shelf) => [shelf.id, shelf]),
    );
    for (const id of ["new-releases", "trending", "studios", "genres"]) {
      const shelf = bothById.get(id);
      assert.ok(shelf?.error, id);
      assert.match(shelf?.error?.code ?? "", /unavailable/, id);
      assert.equal(shelf?.items, undefined, id);
    }
  } finally {
    tpdbFx.fail = 0;
    stashdbFx.fail = 0;
  }

  // Not-configured degrades like any snapshot failure: the surviving
  // provider fills the mixed rail (with a visible per-source note), and
  // counterpart lookups through the dead side resolve to nothing — unlinked
  // tiles, never invented links and never an empty list that could read as
  // a quiet success.
  const key = process.env.STASHDB_API_KEY;
  delete process.env.STASHDB_API_KEY;
  const unconfigured = await call("GET", "/api/discover", { cookie: member });
  process.env.STASHDB_API_KEY = key;
  assert.equal(unconfigured.status, 200);
  const unById = new Map(
    (await shelvesOf(unconfigured)).map((shelf) => [shelf.id, shelf]),
  );
  const unTrending = unById.get("trending");
  assert.equal(unTrending?.error?.code, "provider_not_configured");
  assert.equal(unTrending?.items, undefined);
  const unNew = unById.get("new-releases");
  assert.equal(unNew?.error, undefined);
  assert.ok((unNew?.items?.length ?? 0) > 0);
  for (const item of unNew?.items ?? []) {
    assert.equal(refOf(item)?.provider, "tpdb");
  }
  assert.equal(unNew?.errors?.length, 1);
  assert.equal(unNew?.errors?.[0]?.provider, "stashdb");
  assert.equal(unNew?.errors?.[0]?.code, "provider_not_configured");
  for (const id of [
    "jellyfin-recent",
    "velvarr-requests",
    "studios",
    "genres",
  ]) {
    const shelf = unById.get(id);
    assert.equal(shelf?.error, undefined, id);
    assert.ok((shelf?.items?.length ?? 0) > 0, id);
    if (id === "studios" || id === "genres") {
      // StashDB lookups cannot run without the key: pairing degrades to
      // unlinked, and every rendered tile is TPDB-side.
      for (const tile of (shelf?.items ?? []) as FacetTile[]) {
        assert.equal(tile.provider, "tpdb", `${id}:${tile.id}`);
        assert.equal("linked" in tile, false, `${id}:${tile.id}`);
      }
    }
  }
});

test("the facet directory validates kind, lists both providers' genres, and derives studios uncapped", async () => {
  assert.equal(
    (await call("GET", "/api/discovery/facets?kind=genres")).status,
    401,
  );
  const bad = await call("GET", "/api/discovery/facets?kind=all", {
    cookie: member,
  });
  assert.equal(bad.status, 400);
  assert.equal((await errorShape(bad)).code, "invalid_query");

  const genres = await call("GET", "/api/discovery/facets?kind=genres", {
    cookie: member,
  });
  assert.equal(genres.status, 200);
  const genresBody = (await genres.json()) as {
    kind: string;
    tiles: { facet: string; provider: string; id: string; name: string }[];
    errors: unknown[];
  };
  assert.equal(genresBody.kind, "genres");
  // Each provider's real directory listing, alphabetized within its own
  // side, TPDB first — no snapshot cap, no cross-provider merge.
  assert.deepEqual(
    genresBody.tiles.map((t) => t.name),
    ["Fixture Tag A", "Fixture Tag B", "Fixture Stash Tag"],
  );
  assert.equal(
    genresBody.tiles.every((t) => t.facet === "tag"),
    true,
  );
  assert.deepEqual(genresBody.errors, []);

  const studios = await call("GET", "/api/discovery/facets?kind=studios", {
    cookie: member,
  });
  assert.equal(studios.status, 200);
  const studiosBody = (await studios.json()) as {
    kind: string;
    tiles: { facet: string; provider: string; id: string }[];
    errors: unknown[];
  };
  assert.equal(studiosBody.kind, "studios");
  // Derived from the new-releases page: every studio renders, but the TPDB
  // twin whose counterpart a StashDB tile published is deduped away — the
  // same published-link rule as the discover shelf, uncapped.
  const ids = new Set(studiosBody.tiles.map((t) => `${t.provider}:${t.id}`));
  assert.equal(ids.has(`stashdb:${STASH_STUDIO}`), true);
  assert.equal(ids.has(`tpdb:${TPDB_STUDIO2}`), true);
  assert.equal(ids.has(`tpdb:${TPDB_STUDIO}`), false);
  assert.equal(
    studiosBody.tiles.every((t) => t.facet === "studio"),
    true,
  );

  // Genres and studios are independent reads: the genre page still answers
  // after the studio page (no shared one-shot state).
  const again = await call("GET", "/api/discovery/facets?kind=genres", {
    cookie: member,
  });
  assert.equal(again.status, 200);
});

// --- Wave A: follows, tag facet, bulk requests ---

// json() arrives untyped and no schema validator exists in this suite; these
// are the wire shapes the new routes return.
interface FollowShape {
  id: string;
  reference: { provider: string; kind: string; id: string };
  name: string;
  imageUrl: string | null;
  createdAt: number;
  linked: { provider: string; kind: string; id: string } | null;
}

interface BulkCounters {
  requested: number;
  skipped: number;
  autoApproved: number;
  failed: { id: string; code: string }[];
  scanned: number;
  capped: boolean;
}

test("follows need a session, an accepted origin, and a performer reference", async () => {
  assert.equal((await call("GET", "/api/follows")).status, 401);
  assert.equal(
    (
      await call("POST", "/api/follows", {
        body: {
          performer: {
            provider: "tpdb",
            kind: "performer",
            id: TPDB_PERFORMER,
          },
          name: "Fixture Performer",
        },
      })
    ).status,
    401,
  );

  // member2's live session comes from the identity test above; no fresh
  // login here — the rotation proofs already spent four of the limiter's
  // five attempts for this account.
  // Mutations sit behind the same origin guard as every other route.
  await errorShape(
    await call("POST", "/api/follows", {
      origin: null,
      cookie: member2,
      body: {
        performer: { provider: "tpdb", kind: "performer", id: TPDB_PERFORMER },
        name: "Fixture Performer",
      },
    }),
    403,
  );

  // A movie is requestable media, never a followable performer.
  const notPerformer = await errorShape(
    await call("POST", "/api/follows", {
      cookie: member2,
      body: {
        performer: { provider: "tpdb", kind: "movie", id: TPDB_MOVIE },
        name: "Fixture Movie 1",
      },
    }),
  );
  assert.equal(notPerformer.code, "invalid_field");
});

test("a follow stores the performer snapshot, lists only for its owner, and repeats collide", async () => {
  const created = await call("POST", "/api/follows", {
    cookie: member2,
    body: {
      performer: { provider: "tpdb", kind: "performer", id: TPDB_PERFORMER },
      name: "Fixture Performer",
      imageUrl: "https://cdn.theporndb.net/fixture-poster.jpg",
    },
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { follow: FollowShape };
  const follow = createdBody.follow;
  assert.deepEqual(follow.reference, {
    provider: "tpdb",
    kind: "performer",
    id: TPDB_PERFORMER,
  });
  assert.equal(follow.name, "Fixture Performer");
  assert.equal(follow.imageUrl, "https://cdn.theporndb.net/fixture-poster.jpg");
  assert.ok(follow.id);
  assert.ok(follow.createdAt > 0);

  const mine = await call("GET", "/api/follows", { cookie: member2 });
  assert.equal(mine.status, 200);
  const mineBody = (await mine.json()) as { follows: FollowShape[] };
  assert.deepEqual(
    mineBody.follows.map((f) => f.id),
    [follow.id],
  );
  // Follows are personal: the owner's list stays empty.
  const ownerList = await call("GET", "/api/follows", { cookie: owner });
  assert.equal(ownerList.status, 200);
  const ownerListBody = (await ownerList.json()) as { follows: unknown[] };
  assert.deepEqual(ownerListBody.follows, []);

  const dup = await call("POST", "/api/follows", {
    cookie: member2,
    body: {
      performer: { provider: "tpdb", kind: "performer", id: TPDB_PERFORMER },
      name: "Fixture Performer",
    },
  });
  assert.equal(dup.status, 409);
  const dupBody = (await dup.json()) as { error: { code: string } };
  assert.equal(dupBody.error.code, "already_following");
});

test("a follow whose image URL is not provider artwork is accepted with a null snapshot", async () => {
  // Deliberate degradation: the snapshot is cosmetic, the follow is not lost.
  const created = await call("POST", "/api/follows", {
    cookie: member2,
    body: {
      performer: {
        provider: "stashdb",
        kind: "performer",
        id: STASH_PERFORMER,
      },
      name: "Fixture Stash Performer",
      imageUrl: "https://evil.example/poster.jpg",
    },
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { follow: FollowShape };
  assert.equal(createdBody.follow.imageUrl, null);
  assert.equal(createdBody.follow.reference.id, STASH_PERFORMER);
});

test("unfollowing removes the follow once and then reports follow_not_found", async () => {
  const created = await call("POST", "/api/follows", {
    cookie: member2,
    body: {
      performer: { provider: "tpdb", kind: "performer", id: TPDB_PERFORMER2 },
      name: "Second Fixture Performer",
    },
  });
  assert.equal(created.status, 201);

  await errorShape(
    await call("DELETE", `/api/follows/tpdb/${TPDB_PERFORMER2}`, {
      origin: null,
      cookie: member2,
    }),
    403,
  );
  const gone = await call("DELETE", `/api/follows/tpdb/${TPDB_PERFORMER2}`, {
    cookie: member2,
  });
  assert.equal(gone.status, 204);
  assert.equal(await gone.text(), "");

  // A repeat and a foreign delete are the same indistinguishable 404.
  const again = await call("DELETE", `/api/follows/tpdb/${TPDB_PERFORMER2}`, {
    cookie: member2,
  });
  assert.equal(again.status, 404);
  const againBody = (await again.json()) as { error: { code: string } };
  assert.equal(againBody.error.code, "follow_not_found");
  const foreign = await call("DELETE", `/api/follows/tpdb/${TPDB_PERFORMER}`, {
    cookie: owner,
  });
  assert.equal(foreign.status, 404);
  const foreignBody = (await foreign.json()) as { error: { code: string } };
  assert.equal(foreignBody.error.code, "follow_not_found");

  // The foreign delete touched nothing, and the id was never removed.
  const list = await call("GET", "/api/follows", { cookie: member2 });
  const listBody = (await list.json()) as { follows: FollowShape[] };
  assert.deepEqual(
    listBody.follows.map((f) => f.reference.id).sort(),
    [STASH_PERFORMER, TPDB_PERFORMER].sort(),
  );

  // A malformed id is refused before any deletion is attempted.
  const malformed = await errorShape(
    await call("DELETE", "/api/follows/tpdb/not-a-uuid", { cookie: member2 }),
  );
  assert.equal(malformed.code, "invalid_reference");
});

test("one follow covers both metadata sources, lists the performer once, and unfollows as one", async () => {
  const created = await call("POST", "/api/follows", {
    cookie: member2,
    body: {
      performer: { provider: "tpdb", kind: "performer", id: TPDB_PERFORMER4 },
      name: "Linked Fixture Performer",
    },
  });
  assert.equal(created.status, 201);
  const follow = ((await created.json()) as { follow: FollowShape }).follow;
  // The counterpart comes from the provider's own published URL, resolved on
  // the way in; the response says so.
  assert.deepEqual(follow.linked, {
    provider: "stashdb",
    kind: "performer",
    id: STASH_PERFORMER2,
  });

  // One person, one entry: the StashDB row exists but never doubles the list.
  const listed = async () => {
    const res = await call("GET", "/api/follows", { cookie: member2 });
    return ((await res.json()) as { follows: FollowShape[] }).follows;
  };
  const after = await listed();
  assert.equal(
    after.filter((f) => f.reference.id === TPDB_PERFORMER4).length,
    1,
  );
  assert.equal(
    after.some((f) => f.reference.id === STASH_PERFORMER2),
    false,
  );

  // Unfollowing from the StashDB side proves that row was really created,
  // and takes the pair with it.
  const dropped = await call(
    "DELETE",
    `/api/follows/stashdb/${STASH_PERFORMER2}`,
    { cookie: member2 },
  );
  assert.equal(dropped.status, 204);
  const remaining = await listed();
  assert.equal(
    remaining.some((f) => f.reference.id === TPDB_PERFORMER4),
    false,
  );
});

test("catalog tags are authenticated, provider-scoped, and refuse short terms and unknown providers", async () => {
  assert.equal(
    (await call("GET", "/api/catalog/tags?provider=tpdb&q=Fixture")).status,
    401,
  );

  const tpdbTags = await call(
    "GET",
    "/api/catalog/tags?provider=tpdb&q=Fixture",
    { cookie: member },
  );
  assert.equal(tpdbTags.status, 200);
  const tpdbBody = (await tpdbTags.json()) as {
    tags: { id: string; name: string }[];
  };
  // Exactly this provider's rows — never merged across providers.
  assert.deepEqual(tpdbBody.tags, [
    { id: TAG_A, name: "Fixture Tag A" },
    { id: TAG_B, name: "Fixture Tag B" },
  ]);

  const stashTags = await call(
    "GET",
    "/api/catalog/tags?provider=stashdb&q=Fixture",
    { cookie: member },
  );
  assert.equal(stashTags.status, 200);
  const stashBody = (await stashTags.json()) as {
    tags: { id: string; name: string }[];
  };
  assert.deepEqual(stashBody.tags, [{ id: TAG_B, name: "Fixture Stash Tag" }]);

  // Empty result, no configured key: the response says nothing about
  // suggestions — the feature is inert, and no judgment call is possible.
  const noKey = await call(
    "GET",
    "/api/catalog/tags?provider=tpdb&q=zznomatchy",
    { cookie: member },
  );
  assert.equal(noKey.status, 200);
  const noKeyBody = (await noKey.json()) as Record<string, unknown>;
  assert.deepEqual(noKeyBody.tags, []);
  assert.equal("suggestions" in noKeyBody, false);

  // With a stored TypeSafe key, the empty result gains judged suggestions:
  // real fixture tag ids only, chosen among the provider's own list.
  const keySaved = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: { typesafeApiKey: "ts_route_test" },
  });
  assert.equal(keySaved.status, 200);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("api.typesafe.ai")) {
      return new Response(
        JSON.stringify({
          answers: {
            pick: {
              type: "choice",
              choice: "Fixture Tag A",
              confidence: 0.9,
              probabilities: { "Fixture Tag A": 0.8, none: 0.2 },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return realFetch(url, init);
  }) as typeof fetch;
  try {
    const suggested = await call(
      "GET",
      "/api/catalog/tags?provider=tpdb&q=zznomatchy",
      { cookie: member },
    );
    assert.equal(suggested.status, 200);
    const suggestedBody = (await suggested.json()) as {
      tags: unknown[];
      suggestions?: { id: string; name: string }[];
    };
    assert.deepEqual(suggestedBody.tags, []);
    assert.deepEqual(suggestedBody.suggestions, [
      { id: TAG_A, name: "Fixture Tag A" },
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
  const keyCleared = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: { typesafeApiKey: "" },
  });
  assert.equal(keyCleared.status, 200);

  const tooShort = await errorShape(
    await call("GET", "/api/catalog/tags?provider=tpdb&q=F", {
      cookie: member,
    }),
  );
  assert.equal(tooShort.code, "invalid_query");
  const unknownProvider = await errorShape(
    await call("GET", "/api/catalog/tags?provider=junk&q=Fixture", {
      cookie: member,
    }),
  );
  assert.equal(unknownProvider.code, "invalid_reference");
});

test("bulk requests file one pending intent per provider item with honest counters", async () => {
  assert.equal(
    (await call("POST", "/api/requests/bulk", { body: {} })).status,
    401,
  );
  await errorShape(
    await call("POST", "/api/requests/bulk", {
      origin: null,
      cookie: member,
      body: {
        performer: {
          provider: "tpdb",
          kind: "performer",
          id: TPDB_PERFORMER,
        },
        kind: "movie",
      },
    }),
    403,
  );
  // StashDB has no movie entity: refused before any upstream paging.
  const noStashMovie = await errorShape(
    await call("POST", "/api/requests/bulk", {
      cookie: member,
      body: {
        performer: {
          provider: "stashdb",
          kind: "performer",
          id: STASH_PERFORMER,
        },
        kind: "movie",
      },
    }),
  );
  assert.equal(noStashMovie.code, "invalid_query");

  const body = {
    performer: { provider: "tpdb", kind: "performer", id: TPDB_PERFORMER },
    kind: "movie",
  } as const;
  const first = await call("POST", "/api/requests/bulk", {
    cookie: member,
    body,
  });
  assert.equal(first.status, 200);
  const firstCounters = (await first.json()) as BulkCounters;
  assert.deepEqual(firstCounters, {
    requested: 1,
    skipped: 0,
    autoApproved: 0,
    failed: [],
    scanned: 1,
    capped: false,
  });

  // A repeat run is skipped, never failed, and never duplicates the row.
  const second = await call("POST", "/api/requests/bulk", {
    cookie: member,
    body,
  });
  assert.equal(second.status, 200);
  const secondCounters = (await second.json()) as BulkCounters;
  assert.equal(secondCounters.requested, 0);
  assert.equal(secondCounters.skipped, 1);
  assert.deepEqual(secondCounters.failed, []);

  const listed = await call("GET", "/api/requests", { cookie: owner });
  const listedBody = (await listed.json()) as {
    requests: {
      media: { provider: string; kind: string; id: string };
      decision: string;
    }[];
  };
  const rows = listedBody.requests.filter(
    (r) =>
      r.media.provider === "tpdb" &&
      r.media.kind === "movie" &&
      r.media.id === TPDB_MOVIE5,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.decision, "pending");
});

test("bulk requests stop at the cap, report it, and re-run without duplicating", async () => {
  const body = {
    performer: { provider: "tpdb", kind: "performer", id: TPDB_PERFORMER3 },
    kind: "movie",
  } as const;
  const pendingTitles = async (): Promise<number> => {
    const listed = await call("GET", "/api/requests", { cookie: owner });
    const listedBody = (await listed.json()) as {
      requests: {
        media: { provider: string; kind: string; id: string };
        decision: string;
      }[];
    };
    return listedBody.requests.filter(
      (r) =>
        r.media.provider === "tpdb" &&
        r.media.kind === "movie" &&
        r.media.id === TPDB_MOVIE6 &&
        r.decision === "pending",
    ).length;
  };

  const first = await call("POST", "/api/requests/bulk", {
    cookie: member,
    body,
  });
  assert.equal(first.status, 200);
  const firstCounters = (await first.json()) as BulkCounters;
  // The fixture's filmography chain never runs dry, so the pass reaches the
  // hard cap: 100 titles scanned, one distinct row filed, repeats skipped.
  assert.equal(firstCounters.capped, true);
  assert.equal(firstCounters.scanned, 100);
  assert.equal(firstCounters.requested, 1);
  assert.equal(firstCounters.skipped, 99);
  assert.deepEqual(firstCounters.failed, []);
  assert.equal(await pendingTitles(), 1);

  const second = await call("POST", "/api/requests/bulk", {
    cookie: member,
    body,
  });
  assert.equal(second.status, 200);
  const secondCounters = (await second.json()) as BulkCounters;
  // Re-running the capped backlog files nothing new and duplicates nothing.
  assert.equal(secondCounters.requested, 0);
  assert.equal(secondCounters.skipped, 100);
  assert.deepEqual(secondCounters.failed, []);
  assert.equal(await pendingTitles(), 1);
});

test("the autoApprove grant approves bulk requests and attaches the shared acquisition like the single path", async () => {
  const autoCookie = nogrants; // shared session — no fresh login (limiter).
  const bulk = await call("POST", "/api/requests/bulk", {
    cookie: autoCookie,
    body: {
      performer: {
        provider: "stashdb",
        kind: "performer",
        id: STASH_PERFORMER,
      },
      kind: "scene",
    },
  });
  assert.equal(bulk.status, 200);
  const bulkCounters = (await bulk.json()) as BulkCounters;
  assert.deepEqual(bulkCounters, {
    requested: 1,
    skipped: 0,
    autoApproved: 1,
    failed: [],
    scanned: 1,
    capped: false,
  });
  const bulkAcquisition = getAcquisitionByReference({
    provider: "stashdb",
    kind: "scene",
    id: STASH_SCENE,
  });
  assert.ok(bulkAcquisition);

  // The single-request path attaches the same shape of shared work.
  const single = await call("POST", "/api/requests", {
    cookie: autoCookie,
    body: { media: { provider: "tpdb", kind: "movie", id: TPDB_MOVIE4 } },
  });
  assert.equal(single.status, 201);
  const singleBody = (await single.json()) as {
    request: { decision: string };
    autoApproved: boolean;
  };
  assert.equal(singleBody.autoApproved, true);
  assert.equal(singleBody.request.decision, "approved");
  const singleAcquisition = getAcquisitionByReference({
    provider: "tpdb",
    kind: "movie",
    id: TPDB_MOVIE4,
  });
  assert.ok(singleAcquisition);
  assert.equal(singleAcquisition.state, bulkAcquisition.state);
  assert.notEqual(singleAcquisition.id, bulkAcquisition.id);
});

test("discover appends ONE followed rail across providers and isolates a provider outage", async () => {
  // member2 follows one TPDB and one StashDB performer (from the tests above).
  const ok = await call("GET", "/api/discover", { cookie: member2 });
  assert.equal(ok.status, 200);
  const shelves = await shelvesOf(ok);
  assert.deepEqual(
    shelves.map((shelf) => shelf.id),
    [
      "new-releases",
      "trending",
      "jellyfin-recent",
      "velvarr-requests",
      "studios",
      "genres",
      "followed-titles",
    ],
  );
  const byId = new Map(shelves.map((shelf) => [shelf.id, shelf]));
  const followed = byId.get("followed-titles");
  assert.equal(followed?.error, undefined);
  assert.equal(followed?.source, "velvarr");
  assert.equal(followed?.browse?.view, "following");
  // ONE rail carries BOTH providers' titles; the obsolete per-provider
  // shelves are gone. Membership, not merge order, is the contract.
  const followedRefs = (followed?.items ?? []).map(refOf);
  assert.ok(
    followedRefs.some(
      (ref) => ref?.provider === "tpdb" && ref?.id === TPDB_MOVIE5,
    ),
    "rail carries the TPDB filmography title",
  );
  assert.ok(
    followedRefs.some(
      (ref) => ref?.provider === "stashdb" && ref?.id === STASH_SCENE,
    ),
    "rail carries the StashDB filmography title",
  );

  // A TPDB outage degrades the TPDB sides to visible per-source notes while
  // the StashDB sides keep rendering — the survivor is never silently
  // buried, and nothing fails the page.
  resetMetaCache();
  // Path-matched outage: fail the TPDB movie list and the followed
  // performer's filmography specifically. Discover legitimately issues extra
  // TPDB reads (studio site rows, tag counterpart lookups), so a raw count
  // no longer lands on the intended calls; these two paths pin the isolation
  // contract while facet counterpart reads ride unaffected paths.
  tpdbFx.failPaths = ["/movies", `/performers/${TPDB_PERFORMER}/movies`];
  try {
    const outage = await call("GET", "/api/discover", { cookie: member2 });
    assert.equal(outage.status, 200, "shelf failure must not fail the page");
    const outShelves = await shelvesOf(outage);
    const byId = new Map(outShelves.map((shelf) => [shelf.id, shelf]));
    // Both mixed rails keep their surviving StashDB titles beside a
    // tpdb-tagged warning, with no shelf-level error.
    for (const id of ["new-releases", "followed-titles"]) {
      const shelf = byId.get(id);
      assert.equal(shelf?.error, undefined, id);
      assert.ok((shelf?.items?.length ?? 0) > 0, id);
      for (const item of shelf?.items ?? []) {
        assert.equal(refOf(item)?.provider, "stashdb", `${id} survivor`);
      }
      assert.equal(shelf?.errors?.length, 1, id);
      assert.equal(shelf?.errors?.[0]?.provider, "tpdb", id);
      assert.match(shelf?.errors?.[0]?.code ?? "", /unavailable/, id);
    }
    for (const id of [
      "trending",
      "jellyfin-recent",
      "velvarr-requests",
      "studios",
      "genres",
    ]) {
      const shelf = byId.get(id);
      assert.equal(shelf?.error, undefined, id);
      assert.ok((shelf?.items?.length ?? 0) > 0, id);
    }
  } finally {
    tpdbFx.failPaths = [];
  }

  // Leave the standard six shelves for everyone after this test.
  for (const [provider, id] of [
    ["tpdb", TPDB_PERFORMER],
    ["stashdb", STASH_PERFORMER],
  ] as const) {
    const removed = await call("DELETE", `/api/follows/${provider}/${id}`, {
      cookie: member2,
    });
    assert.equal(removed.status, 204);
  }
});

test("global search: six isolated categories, auth, blank q 400", async () => {
  assert.equal((await call("GET", "/api/search?q=Fixture")).status, 401);

  // Missing or too-short q is an explicit 400, never an empty result.
  for (const query of ["/api/search", "/api/search?q=", "/api/search?q=f"]) {
    const short = await call("GET", query, { cookie: member });
    assert.equal(short.status, 400, query);
    const errShape = (await short.json()) as { error?: { code?: string } };
    assert.equal(errShape.error?.code, "invalid_query", query);
  }

  const ok = await call("GET", "/api/search?q=Fixture", { cookie: member });
  assert.equal(ok.status, 200);
  const search = await searchOf(ok);
  assert.equal(search.query, "Fixture");
  assert.deepEqual(
    search.categories.map((category) => category.id),
    [
      "tpdb-movies",
      "stashdb-scenes",
      "tpdb-performers",
      "stashdb-performers",
      "tpdb-studios",
      "stashdb-studios",
    ],
  );
  const [
    moviesCat,
    stashScenesCat,
    performersCat,
    stashPerformersCat,
    studiosCat,
    stashStudiosCat,
  ] = search.categories;
  for (const category of search.categories) {
    assert.equal(category.error, undefined, category.id);
    assert.ok(category.items.length > 0, category.id);
    // Never merged: every item belongs to the category's own provider.
    for (const item of category.items) {
      assert.equal(item.reference.provider, category.provider, category.id);
    }
  }
  assert.deepEqual(moviesCat?.items[0]?.reference, {
    provider: "tpdb",
    kind: "movie",
    id: TPDB_MOVIE,
  });
  assert.deepEqual(performersCat?.items[0]?.reference, {
    provider: "tpdb",
    kind: "performer",
    id: TPDB_PERFORMER,
  });
  assert.deepEqual(stashScenesCat?.items[0]?.reference, {
    provider: "stashdb",
    kind: "scene",
    id: STASH_SCENE,
  });
  assert.deepEqual(stashPerformersCat?.items[0]?.reference, {
    provider: "stashdb",
    kind: "performer",
    id: STASH_PERFORMER,
  });
  assert.deepEqual(studiosCat?.items[0]?.reference, {
    provider: "tpdb",
    kind: "studio",
    id: TPDB_STUDIO,
  });
  assert.deepEqual(stashStudiosCat?.items[0]?.reference, {
    provider: "stashdb",
    kind: "studio",
    id: STASH_STUDIO,
  });

  // One provider's outage isolates to its own categories only. First-contact:
  // the earlier search cached these categories.
  resetMetaCache();
  stashdbFx.fail = 3;
  const outage = await call("GET", "/api/search?q=Fixture", { cookie: member });
  assert.equal(outage.status, 200, "category failure must not fail the page");
  const outageSearch = await searchOf(outage);
  const [
    outMovies,
    outStashScenes,
    outPerformers,
    outStashPerformers,
    outStudios,
    outStashStudios,
  ] = outageSearch.categories;
  for (const category of [
    outStashScenes,
    outStashPerformers,
    outStashStudios,
  ]) {
    assert.ok(category?.error, category?.id);
    assert.match(category?.error?.code ?? "", /unavailable/, category?.id);
    assert.deepEqual(category?.items, [], category?.id);
  }
  for (const category of [outMovies, outPerformers, outStudios]) {
    assert.equal(category?.error, undefined, category?.id);
    assert.ok((category?.items.length ?? 0) > 0, category?.id);
  }
});

// --- M3: studioMode — accepted only for StashDB scene + studio filter ---
test("studioMode: withChildren reaches provider; every other combo is a 400 before upstream", async () => {
  // StashDB env points at the fixture (set by the studio-search test above).
  const ok = await call(
    "GET",
    `/api/catalog/search?provider=stashdb&kind=scene&studio=${STASH_STUDIO}&studioMode=withChildren`,
    { cookie: member },
  );
  assert.equal(ok.status, 200);
  const okBody = (await ok.json()) as {
    items: { reference: { id: string } }[];
  };
  assert.equal(okBody.items[0]?.reference.id, STASH_SCENE);
  // The provider layer actually issued the parentStudio criterion.
  assert.match(stashdbFx.lastVars, /parentStudio/);

  // Explicit rejections before any upstream call.
  const before = stashdbFx.calls;
  const rejected = [
    `provider=stashdb&kind=performer&q=x&studio=${STASH_STUDIO}&studioMode=exact`,
    `provider=stashdb&kind=studio&q=x&studio=${STASH_STUDIO}&studioMode=exact`,
    `provider=stashdb&kind=scene&studioMode=exact`,
    `provider=stashdb&kind=scene&studio=${STASH_STUDIO}&studioMode=sometimes`,
  ];
  for (const query of rejected) {
    const res = await call("GET", `/api/catalog/search?${query}`, {
      cookie: member,
    });
    assert.equal(res.status, 400, query);
    const errBody = (await res.json()) as { error: { code: string } };
    assert.equal(errBody.error.code, "invalid_query", query);
  }
  assert.equal(stashdbFx.calls, before, "no upstream call on rejection");
});

// --- M4 wire shapes. Named boundary casts per the suite convention: json()
// arrives untyped and no schema validator exists in this suite. ---
interface OutcomeBody {
  outcome: string;
  observationStale?: boolean;
}

interface AcquisitionDetailBody {
  acquisition: { state: string; observationStale: boolean } | null;
}

interface AccountsBody {
  accounts: { id: string }[];
}

async function outcomeOf(res: Response): Promise<OutcomeBody> {
  return (await res.json()) as OutcomeBody;
}

// --- M4: scan lag (hazard 9) — awaiting_scan is distinct from missing ---
test("scan lag: imported-but-unscanned is awaiting_scan; outage and denial stay truthful", async () => {
  // An identity that was never acquired stays missing.
  const never = await call(
    "GET",
    "/api/availability/tpdb/movie/2a2b3c4d-0000-0000-0000-000000000005",
    { cookie: member },
  );
  assert.equal((await outcomeOf(never)).outcome, "missing");

  // Worker-equivalent: persist observed Whisparr facts on the shared
  // acquisition for TPDB_MOVIE4 (approved earlier, never observed).
  const acq = getAcquisitionByReference({
    provider: "tpdb",
    kind: "movie",
    id: TPDB_MOVIE4,
  });
  assert.ok(acq);
  const observation = {
    state: "monitoring" as const,
    item: {
      whisparrId: 91,
      path: "/data/whisparr/unscanned.mkv",
      title: "Unscanned Movie",
    },
  };

  // Monitoring (nothing imported yet) stays missing, never awaiting_scan.
  recordAcquisitionObservation(acq.id, observation);
  const monitoring = await call(
    "GET",
    `/api/availability/tpdb/movie/${TPDB_MOVIE4}`,
    { cookie: member },
  );
  assert.equal((await outcomeOf(monitoring)).outcome, "missing");

  // Imported but unscanned: the file exists, the library has not caught up.
  recordAcquisitionObservation(acq.id, { ...observation, state: "imported" });
  const lagging = await call(
    "GET",
    `/api/availability/tpdb/movie/${TPDB_MOVIE4}`,
    { cookie: member },
  );
  const lagBody = await outcomeOf(lagging);
  assert.equal(lagBody.outcome, "awaiting_scan");
  assert.equal(lagBody.observationStale, false);

  // Catalog detail surfaces the shared state with honest freshness labeling.
  const detail = await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE}`, {
    cookie: member,
  });
  const detailBody = (await detail.json()) as AcquisitionDetailBody;
  assert.equal(detailBody.acquisition?.state, "monitoring");
  assert.equal(detailBody.acquisition?.observationStale, false);

  // A Jellyfin outage during scan lag stays unavailable, never awaiting_scan.
  fx.fail.items = 1;
  const outage = await call(
    "GET",
    `/api/availability/tpdb/movie/${TPDB_MOVIE4}`,
    { cookie: member },
  );
  assert.equal((await outcomeOf(outage)).outcome, "unavailable");

  // A library-denied caller stays denied even while the item is imported.
  const denied = await call(
    "GET",
    `/api/availability/tpdb/movie/${TPDB_MOVIE4}`,
    { cookie: nogrants },
  );
  assert.equal((await outcomeOf(denied)).outcome, "denied");

  // A proven Whisparr absence demotes back to missing — no false scan lag.
  recordAcquisitionObservation(acq.id, {
    absent: true,
    reason: "Removed from Whisparr.",
  });
  const gone = await call(
    "GET",
    `/api/availability/tpdb/movie/${TPDB_MOVIE4}`,
    { cookie: member },
  );
  assert.equal((await outcomeOf(gone)).outcome, "missing");
});

// --- M4: hazard 5 — foreign origin rejected on EVERY mutating route ---
// setup/inspect, setup, login (CSRF test), POST /api/requests and
// PATCH /api/requests/:id (request lifecycle test) are covered above; this
// test closes the remaining mutating surface and proves no state changed.
test("foreign origin is rejected on the remaining mutating routes before any mutation", async () => {
  const evil = "https://evil.example";

  // Foreign logout must not revoke the real session.
  await errorShape(
    await call("POST", "/api/logout", {
      origin: evil,
      cookie: member,
      body: {},
    }),
    403,
  );
  assert.equal((await call("GET", "/api/me", { cookie: member })).status, 200);

  await errorShape(
    await call("POST", "/api/admin/users/import", {
      origin: evil,
      cookie: owner,
      body: {},
    }),
    403,
  );

  // Grant mutation: rejected, and the target account is unchanged afterwards.
  const listed = await call("GET", "/api/admin/users", { cookie: owner });
  const beforeBody = (await listed.json()) as AccountsBody;
  const before = JSON.stringify(
    beforeBody.accounts.find((account) => account.id === MEMBER_ID),
  );
  await errorShape(
    await call("PATCH", `/api/admin/users/${MEMBER_ID}`, {
      origin: evil,
      cookie: owner,
      body: {
        enabled: true,
        role: "admin",
        libraryIds: [MOVIES_LIB, SHOWS_LIB],
      },
    }),
    403,
  );
  const relisted = await call("GET", "/api/admin/users", { cookie: owner });
  const afterBody = (await relisted.json()) as AccountsBody;
  assert.equal(
    JSON.stringify(
      afterBody.accounts.find((account) => account.id === MEMBER_ID),
    ),
    before,
  );

  await errorShape(
    await call("PATCH", "/api/admin/integrations", {
      origin: evil,
      cookie: owner,
      body: {},
    }),
    403,
  );

  // Personal preferences are a guarded mutation too, and the rejection must
  // precede any validation: the caller's stored tags are unchanged.
  await errorShape(
    await call("PATCH", "/api/me/preferences", {
      origin: evil,
      cookie: member,
      body: { hiddenTags: [] },
    }),
    403,
  );
});

// --- M4: hazard 2 — warmed artwork/detail stays protected for everyone else ---
test("warmed library artwork and detail refuse anonymous, library-denied and revoked callers", async () => {
  // An admitted, granted user fetches the bytes first ("warming").
  const warm = await call("GET", `/api/images/${ITEM_MOVIE}`, {
    cookie: member,
  });
  assert.equal(warm.status, 200);

  // Anonymous: no session, no bytes.
  const anon = await call("GET", `/api/images/${ITEM_MOVIE}`);
  assert.equal(anon.status, 401);
  await errorShape(await call("GET", `/api/library/${ITEM_MOVIE}`), 401);

  // Library-denied: admitted but granted no libraries; denied without
  // upstream contact (anti-enumeration 404).
  const denied = nogrants; // shared session — no fresh login (limiter).
  await errorShape(
    await call("GET", `/api/images/${ITEM_MOVIE}`, { cookie: denied }),
  );
  await errorShape(
    await call("GET", `/api/library/${ITEM_MOVIE}`, { cookie: denied }),
  );

  // Revoked: after logout the same cookie is dead for protected reads.
  const still = await call("GET", `/api/library/${ITEM_MOVIE}`, {
    cookie: member,
  });
  assert.equal(still.status, 200);
  await call("POST", "/api/logout", { cookie: member, body: {} });
  const revokedImage = await call("GET", `/api/images/${ITEM_MOVIE}`, {
    cookie: member,
  });
  assert.equal(revokedImage.status, 401);
  const revokedItem = await call("GET", `/api/library/${ITEM_MOVIE}`, {
    cookie: member,
  });
  assert.equal(revokedItem.status, 401);
});

// --- M7: removal endpoints — gates, authority, privacy, origin, impact ---

// Bucket-safe casting: "wrecked" is the granted requester, "member" is
// promoted to moderator+grant, and the owner keeps the un-revoked setup
// session as the elevated-but-ungranted approver. No identity is logged in
// more than twice, so the login limiter's five-per-window budget holds.
test("removals: gates, level authority, decline/cancel, privacy, origin", async () => {
  // The suite never sets the flag; restore that state no matter how we exit.
  try {
    const removalMedia = {
      provider: "tpdb",
      kind: "movie",
      id: TPDB_MOVIE,
    } as const;

    // Admit the fixture user first (no grant yet).
    const admit = await call("PATCH", `/api/admin/users/${DISABLED_ID}`, {
      cookie: owner,
      body: { enabled: true, role: "requester", libraryIds: [] },
    });
    assert.equal(admit.status, 200);

    // Flag off: the collection still answers, visibly unavailable, and
    // creation refuses with the explicit code before anything else.
    delete process.env.VELVARR_ENABLE_REMOVAL;
    const wreckedOff = await loginAs("wrecked");
    const off = await call("GET", "/api/removals", { cookie: wreckedOff });
    assert.equal(off.status, 200);
    const offBody = (await off.json()) as {
      removals: unknown[];
      enabled: boolean;
    };
    assert.equal(offBody.enabled, false);
    assert.deepEqual(offBody.removals, []);
    const offCreate = await errorShape(
      await call("POST", "/api/removals", {
        cookie: wreckedOff,
        body: { media: removalMedia, reason: "flag off" },
      }),
      403,
    );
    assert.equal(offCreate.code, "removal_disabled");

    // Flag on, grant off: refused at the boundary with the storage code.
    process.env.VELVARR_ENABLE_REMOVAL = "1";
    const noGrant = await call("POST", "/api/removals", {
      cookie: wreckedOff,
      body: { media: removalMedia, reason: "not admitted" },
    });
    assert.equal(noGrant.status, 403);
    assert.equal(
      ((await noGrant.json()) as { error: { code: string } }).error.code,
      "account_not_admitted",
    );

    // The grant, exactly like autoApprove: settable and preserved on
    // omission (a grant change revokes sessions by design, so re-login).
    const granted = await call("PATCH", `/api/admin/users/${DISABLED_ID}`, {
      cookie: owner,
      body: {
        enabled: true,
        role: "requester",
        libraryIds: [],
        canRemove: true,
      },
    });
    assert.equal(granted.status, 200);
    assert.equal(
      ((await granted.json()) as { account: { canRemove: boolean } }).account
        .canRemove,
      true,
    );
    const omitted = await call("PATCH", `/api/admin/users/${DISABLED_ID}`, {
      cookie: owner,
      body: { enabled: true, role: "requester", libraryIds: [] },
    });
    assert.equal(omitted.status, 200);
    assert.equal(
      ((await omitted.json()) as { account: { canRemove: boolean } }).account
        .canRemove,
      true,
    );
    const wrecked = await loginAs("wrecked");

    // Creation: 201 pending with a null level; a supplied level key is
    // refused outright, never read.
    const created = await call("POST", "/api/removals", {
      cookie: wrecked,
      body: { media: removalMedia, reason: "gone from the library too long" },
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as {
      removal: {
        id: string;
        decision: string;
        level: string | null;
        reason: string;
      };
    };
    assert.equal(createdBody.removal.decision, "pending");
    assert.equal(createdBody.removal.level, null);
    assert.equal(createdBody.removal.reason, "gone from the library too long");
    const removalId = createdBody.removal.id;
    const withLevel = await call("POST", "/api/removals", {
      cookie: wrecked,
      body: {
        media: { provider: "tpdb", kind: "movie", id: TPDB_MOVIE2 },
        reason: "second",
        level: "drop",
      },
    });
    assert.equal(withLevel.status, 400);
    assert.equal(
      ((await withLevel.json()) as { error: { code: string } }).error.code,
      "invalid_field",
    );

    // A requester cannot approve — even holding the removal grant.
    const selfApprove = await call("PATCH", `/api/removals/${removalId}`, {
      cookie: wrecked,
      body: { decision: "approved", level: "drop" },
    });
    assert.equal(selfApprove.status, 403);
    assert.equal(
      ((await selfApprove.json()) as { error: { code: string } }).error.code,
      "forbidden",
    );

    // An elevated approver without the grant is refused too (the owner's
    // setup session was never revoked: no account change touched it).
    const noGrantApprove = await call("PATCH", `/api/removals/${removalId}`, {
      cookie: owner,
      body: { decision: "approved", level: "drop" },
    });
    assert.equal(noGrantApprove.status, 403);
    assert.equal(
      ((await noGrantApprove.json()) as { error: { code: string } }).error.code,
      "forbidden",
    );

    // Promote member to moderator + grant; the approval level rules bind.
    const promoted = await call("PATCH", `/api/admin/users/${MEMBER_ID}`, {
      cookie: owner,
      body: {
        enabled: true,
        role: "moderator",
        libraryIds: [MOVIES_LIB],
        canRemove: true,
      },
    });
    assert.equal(promoted.status, 200);
    member = await loginAs("member");

    const noLevel = await errorShape(
      await call("PATCH", `/api/removals/${removalId}`, {
        cookie: member,
        body: { decision: "approved" },
      }),
    );
    assert.equal(noLevel.code, "invalid_level");
    const badLevel = await errorShape(
      await call("PATCH", `/api/removals/${removalId}`, {
        cookie: member,
        body: { decision: "approved", level: "delete_everything" },
      }),
    );
    assert.equal(badLevel.code, "invalid_level");
    const approved = await call("PATCH", `/api/removals/${removalId}`, {
      cookie: member,
      body: { decision: "approved", level: "drop" },
    });
    assert.equal(approved.status, 200);
    const approvedBody = (await approved.json()) as {
      removal: { decision: string; level: string };
    };
    assert.equal(approvedBody.removal.decision, "approved");
    assert.equal(approvedBody.removal.level, "drop");

    // Decline: elevated role only, and a level is rejected there too.
    const second = await call("POST", "/api/removals", {
      cookie: wrecked,
      body: {
        media: { provider: "tpdb", kind: "movie", id: TPDB_MOVIE2 },
        reason: "second",
      },
    });
    assert.equal(second.status, 201);
    const secondId = ((await second.json()) as { removal: { id: string } })
      .removal.id;
    await errorShape(
      await call("PATCH", `/api/removals/${secondId}`, {
        cookie: wrecked,
        body: { decision: "declined" },
      }),
      403,
    );
    const declineLevel = await errorShape(
      await call("PATCH", `/api/removals/${secondId}`, {
        cookie: member,
        body: { decision: "declined", level: "drop" },
      }),
    );
    assert.equal(declineLevel.code, "invalid_level");
    const declined = await call("PATCH", `/api/removals/${secondId}`, {
      cookie: member,
      body: { decision: "declined" },
    });
    assert.equal(declined.status, 200);
    assert.equal(
      ((await declined.json()) as { removal: { decision: string } }).removal
        .decision,
      "declined",
    );

    // Cancel: the requester's own intent only; a foreign cancel is a bare
    // 404 with no existence leak.
    const third = await call("POST", "/api/removals", {
      cookie: wrecked,
      body: {
        media: { provider: "stashdb", kind: "scene", id: STASH_SCENE },
        reason: "third",
      },
    });
    assert.equal(third.status, 201);
    const thirdId = ((await third.json()) as { removal: { id: string } })
      .removal.id;
    const cancelled = await call("PATCH", `/api/removals/${thirdId}`, {
      cookie: wrecked,
      body: { decision: "cancelled" },
    });
    assert.equal(cancelled.status, 200);
    const cancelAgain = await call("PATCH", `/api/removals/${thirdId}`, {
      cookie: wrecked,
      body: { decision: "cancelled" },
    });
    assert.equal(cancelAgain.status, 409);
    assert.equal(
      ((await cancelAgain.json()) as { error: { code: string } }).error.code,
      "removal_request_not_cancellable",
    );
    const foreignCancel = await call("PATCH", `/api/removals/${removalId}`, {
      cookie: member,
      body: { decision: "cancelled" },
    });
    assert.equal(foreignCancel.status, 404);
    assert.equal(
      ((await foreignCancel.json()) as { error: { code: string } }).error.code,
      "removal_request_not_found",
    );
    const unknownId = "9".repeat(8) + "-0000-0000-0000-" + "9".repeat(12);
    const unknownDecision = await call("PATCH", `/api/removals/${unknownId}`, {
      cookie: member,
      body: { decision: "declined" },
    });
    assert.equal(unknownDecision.status, 404);
    assert.equal(
      ((await unknownDecision.json()) as { error: { code: string } }).error
        .code,
      "removal_request_not_found",
    );

    // Privacy: a requester's list never contains another user's removal;
    // elevated viewers see the whole collection.
    const wreckedList = await call("GET", "/api/removals", {
      cookie: wrecked,
    });
    const wreckedListBody = (await wreckedList.json()) as {
      removals: { id: string; decision: string }[];
      enabled: boolean;
    };
    assert.equal(wreckedListBody.enabled, true);
    assert.deepEqual(
      wreckedListBody.removals.map((r) => r.id).sort(),
      [removalId, secondId, thirdId].sort(),
    );
    const ownerList = (await (
      await call("GET", "/api/removals", { cookie: owner })
    ).json()) as { removals: { id: string }[] };
    assert.deepEqual(
      ownerList.removals.map((r) => r.id).sort(),
      [removalId, secondId, thirdId].sort(),
    );

    // Foreign origin is rejected on all three mutating removal routes
    // before any state changes.
    await errorShape(
      await call("POST", "/api/removals", {
        origin: "https://evil.example",
        cookie: wrecked,
        body: { media: removalMedia, reason: "evil" },
      }),
      403,
    );
    await errorShape(
      await call("PATCH", `/api/removals/${removalId}`, {
        origin: "https://evil.example",
        cookie: member,
        body: { decision: "declined" },
      }),
      403,
    );
    const after = (await (
      await call("GET", "/api/removals", { cookie: wrecked })
    ).json()) as { removals: { id: string; decision: string }[] };
    assert.equal(after.removals.length, wreckedListBody.removals.length);
    assert.equal(
      after.removals.find((r) => r.id === removalId)?.decision,
      "approved",
    );

    // Flag off again: the collection still answers, still refuses mutations.
    delete process.env.VELVARR_ENABLE_REMOVAL;
    const offAgain = await errorShape(
      await call("POST", "/api/removals", {
        cookie: wrecked,
        body: { media: removalMedia, reason: "flag off again" },
      }),
      403,
    );
    assert.equal(offAgain.code, "removal_disabled");
    const offList = await call("GET", "/api/removals", { cookie: wrecked });
    assert.equal(
      ((await offList.json()) as { enabled: boolean }).enabled,
      false,
    );
  } finally {
    delete process.env.VELVARR_ENABLE_REMOVAL;
  }
});

test("removals impact: strictly read-only preview under the caller's own authority", async () => {
  process.env.VELVARR_ENABLE_REMOVAL = "1";
  fx.journal = [];
  fx.journalOn = true;
  try {
    // The owner: Jellyfin administrator, so deletion is permitted by the
    // caller's own policy.
    const ownerView = await call(
      "GET",
      `/api/removals/impact?provider=tpdb&kind=movie&id=${TPDB_MOVIE}`,
      { cookie: owner },
    );
    assert.equal(ownerView.status, 200);
    const ownerBody = (await ownerView.json()) as {
      whisparr: {
        found: boolean;
        path?: string;
        fileCount?: number;
        sizeOnDisk?: number;
        monitored?: boolean;
      } | null;
      jellyfin: { matched: boolean; itemName?: string; libraryName?: string };
      canDeleteInJellyfin: boolean;
    };
    assert.deepEqual(ownerBody.whisparr, {
      found: true,
      path: `/data/whisparr/${ITEM_MOVIE}.mkv`,
      fileCount: 2,
      sizeOnDisk: 741_234_567,
      monitored: true,
    });
    assert.equal(ownerBody.jellyfin.matched, true);
    assert.equal(ownerBody.jellyfin.itemName, "Alpha Movie");
    assert.equal(ownerBody.jellyfin.libraryName, "Movies");
    assert.equal(ownerBody.canDeleteInJellyfin, true);

    // The member sees the same identity, but their own Jellyfin policy does
    // not permit deletion — the answer is per-caller, never global.
    const memberView = await call(
      "GET",
      `/api/removals/impact?provider=tpdb&kind=movie&id=${TPDB_MOVIE}`,
      { cookie: member },
    );
    assert.equal(memberView.status, 200);
    const memberBody = (await memberView.json()) as {
      jellyfin: { matched: boolean; itemName?: string };
      canDeleteInJellyfin: boolean;
    };
    assert.equal(memberBody.jellyfin.matched, true);
    assert.equal(memberBody.jellyfin.itemName, "Alpha Movie");
    assert.equal(memberBody.canDeleteInJellyfin, false);

    // An identity absent from both systems answers honestly.
    const absent = await call(
      "GET",
      `/api/removals/impact?provider=tpdb&kind=movie&id=${TPDB_MOVIE4}`,
      { cookie: member },
    );
    assert.equal(absent.status, 200);
    const absentBody = (await absent.json()) as {
      whisparr: { found: boolean } | null;
      jellyfin: { matched: boolean };
      canDeleteInJellyfin: boolean;
    };
    assert.deepEqual(absentBody.whisparr, { found: false });
    assert.equal(absentBody.jellyfin.matched, false);
    assert.equal(absentBody.canDeleteInJellyfin, false);
  } finally {
    fx.journalOn = false;
    delete process.env.VELVARR_ENABLE_REMOVAL;
  }
  // Zero destructive requests: only GETs ever reached either fixture server.
  assert.ok(fx.journal.length > 0, "impact preview contacted the fixtures");
  assert.deepEqual(
    fx.journal.filter((entry) => entry.method !== "GET"),
    [],
    JSON.stringify(fx.journal),
  );
});

// The sidebar approval badge counts only work the account may really decide:
// staff see every pending request, an autoApprove holder only its own, and a
// plain requester never gets a number for someone else's queue.
test("pending approval count follows the same authority as the decision gate", () => {
  const rows = [
    { id: "1", accountId: "owner", decision: "pending" },
    { id: "2", accountId: "guest", decision: "pending" },
    { id: "3", accountId: "guest", decision: "approved" },
    { id: "4", accountId: "owner", decision: "declined" },
  ] as unknown as Parameters<typeof countPendingApprovals>[0];
  const account = (role: string, id: string, autoApprove = false) =>
    ({
      id,
      name: id,
      role,
      enabled: true,
      libraryIds: [],
      autoApprove,
      canRemove: false,
    }) as unknown as Parameters<typeof countPendingApprovals>[1];

  assert.equal(countPendingApprovals(rows, account("admin", "owner")), 2);
  assert.equal(countPendingApprovals(rows, account("moderator", "mod")), 2);
  // A plain requester decides nothing, even their own pending row.
  assert.equal(countPendingApprovals(rows, account("requester", "guest")), 0);
  // The autoApprove grant reaches exactly one row: their own pending request.
  assert.equal(
    countPendingApprovals(rows, account("requester", "guest", true)),
    1,
  );
  // Nothing pending means no badge at all, never a zero.
  assert.equal(
    countPendingApprovals(
      rows.filter((r) => r.decision !== "pending"),
      account("admin", "owner"),
    ),
    0,
  );
});

// The admin user table is one row per account: the stored account plus the
// two live facts only that surface needs — how many intents the account
// filed, and whether Jellyfin holds an avatar for it.
test("admin user rows carry live request counts and avatar tags only when upstream has one", async () => {
  const rowsOf = async () => {
    const res = await call("GET", "/api/admin/users", { cookie: owner });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      accounts: {
        id: string;
        requestCount: number;
        joinedAt: number;
        avatarTag?: string;
      }[];
    };
    return body.accounts;
  };

  // The owner files no intents anywhere else in this suite: the count
  // starts at a true zero, not an accumulated unknown.
  assert.equal(
    (await rowsOf()).find((row) => row.id === OWNER_ID)?.requestCount,
    0,
  );

  // Two intents filed through the real request API move the owner's count
  // from 0 to exactly 2. The owner is an ADMIN: no autoApprove grant is
  // possible for that account (the UI locks it), and the role alone must
  // auto-approve its own requests — each POST is born approved.
  for (const id of [TPDB_MOVIE7, TPDB_MOVIE8]) {
    const filed = await call("POST", "/api/requests", {
      cookie: owner,
      body: { media: { provider: "tpdb", kind: "movie", id } },
    });
    assert.equal(filed.status, 201);
    const filedBody = (await filed.json()) as {
      autoApproved?: boolean;
      request: { decision: string };
    };
    assert.equal(filedBody.autoApproved, true);
    assert.equal(filedBody.request.decision, "approved");
  }
  const rows = await rowsOf();
  assert.equal(rows.find((row) => row.id === OWNER_ID)?.requestCount, 2);
  // An account that never filed stays at zero.
  assert.equal(rows.find((row) => row.id === DISABLED_ID)?.requestCount, 0);

  // Every row carries a real import timestamp.
  for (const row of rows) assert.ok(row.joinedAt > 0);

  // member2 has a PrimaryImageTag upstream; the owner does not. Absence is
  // a missing key, never an undefined value.
  assert.equal(
    typeof rows.find((row) => row.id === MEMBER2_ID)?.avatarTag,
    "string",
  );
  const ownerRow = rows.find((row) => row.id === OWNER_ID);
  assert.ok(ownerRow);
  assert.ok(!("avatarTag" in ownerRow));
});

// The avatar route is the only image proxy for user rows: admins get the
// upstream bytes; requesters are refused by authority before any upstream
// contact.
test("user avatar proxy serves Jellyfin bytes to admins and refuses requesters", async () => {
  const listed = await call("GET", "/api/admin/users", { cookie: owner });
  const listedBody = (await listed.json()) as {
    accounts: { id: string; avatarTag?: string }[];
  };
  const rows = listedBody.accounts;
  const tag = rows.find((row) => row.id === MEMBER2_ID)?.avatarTag;
  assert.equal(typeof tag, "string");

  const ok = await call(
    "GET",
    `/api/admin/users/${MEMBER2_ID}/avatar?tag=${tag}`,
    { cookie: owner },
  );
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") ?? "", /^image\//);
  assert.ok(Buffer.from(await ok.arrayBuffer()).equals(PNG_1PX));

  const refused = await call(
    "GET",
    `/api/admin/users/${MEMBER2_ID}/avatar?tag=${tag}`,
    { cookie: member },
  );
  assert.equal(refused.status, 403);
  const refusedBody = (await refused.json()) as {
    error: { code: unknown; message: unknown };
  };
  assert.equal(typeof refusedBody.error.code, "string");
  assert.equal(typeof refusedBody.error.message, "string");
});

// --- Wave 6: preferences, browse, related, hidden-tag filtering ---

interface TagSelectionBody {
  name: string;
  tpdb?: string;
  stashdb?: string;
}

interface PreferencesBody {
  hiddenTags: TagSelectionBody[];
  discoverOrder: string[];
}

interface BrowsePageBody {
  items: FacetTile[];
  page: number;
  perPage: number;
  hasMore: boolean;
  total?: number;
  totalCountKnown: boolean;
  errors: { provider: string; code: string; message: string }[];
  hiddenTagCount: number;
}

interface RelatedBody {
  items: FacetTile[];
  ranking: string;
  canRank: boolean;
  errors: { provider: string; code: string; message: string }[];
}

// The discover registry order every fresh account resolves to; mirrors
// DISCOVER_SHELVES in contracts.ts.
const DEFAULT_ORDER = [
  "new-releases",
  "trending",
  "jellyfin-recent",
  "velvarr-requests",
  "studios",
  "genres",
  "followed-titles",
];

test("content preferences are session-only, self-owned, and atomic on malformed input", async () => {
  // Admission first: anonymous callers get nothing.
  assert.equal((await call("GET", "/api/me/preferences")).status, 401);
  assert.equal(
    (await call("PATCH", "/api/me/preferences", { body: { hiddenTags: [] } }))
      .status,
    401,
  );

  // Empty default for a fresh account.
  const initial = await call("GET", "/api/me/preferences", { cookie: member });
  assert.equal(initial.status, 200);
  const initialBody = (await initial.json()) as PreferencesBody;
  assert.deepEqual(initialBody.hiddenTags, []);
  assert.deepEqual(initialBody.discoverOrder, DEFAULT_ORDER);

  const hidden: TagSelectionBody[] = [{ name: "Fixture Tag A", tpdb: TAG_A }];
  const saved = await call("PATCH", "/api/me/preferences", {
    cookie: member,
    body: { hiddenTags: hidden },
  });
  assert.equal(saved.status, 200);
  const savedBody = (await saved.json()) as PreferencesBody;
  assert.deepEqual(savedBody, {
    hiddenTags: hidden,
    discoverOrder: DEFAULT_ORDER,
  });

  // Ownership: another account reads its own list, and cannot move mine by
  // smuggling an account id into the body — the envelope rejects unknown
  // keys outright, and my list survives untouched.
  const other = await call("GET", "/api/me/preferences", {
    cookie: member2,
  });
  const otherBody = (await other.json()) as PreferencesBody;
  assert.deepEqual(otherBody.hiddenTags, []);
  await errorShape(
    await call("PATCH", "/api/me/preferences", {
      cookie: member2,
      body: { accountId: MEMBER_ID, hiddenTags: [] },
    }),
  );
  const afterSmuggle = await call("GET", "/api/me/preferences", {
    cookie: member,
  });
  const afterSmuggleBody = (await afterSmuggle.json()) as PreferencesBody;
  assert.deepEqual(afterSmuggleBody, {
    hiddenTags: hidden,
    discoverOrder: DEFAULT_ORDER,
  });

  // Malformed payloads are atomic rejections: wrong envelope, wrong types,
  // empty names, missing provider references, bad uuids, oversize lists.
  // The previous list survives every one of them.
  const malformed: unknown[] = [
    {},
    { hiddenTags: "all" },
    { hiddenTags: { name: "Fixture Tag A" } },
    { hiddenTags: [{ name: "", tpdb: TAG_A }] },
    { hiddenTags: [{ name: "x".repeat(121), tpdb: TAG_A }] },
    { hiddenTags: [{ stashdb: TAG_D }] },
    { hiddenTags: [{ name: "Fixture Tag A", tpdb: "not-a-uuid" }] },
    { hiddenTags: [{ tpdb: TAG_A }] },
    { hiddenTags: [{ name: "Fixture Tag A", tpdb: TAG_A, junk: 1 }] },
    {
      hiddenTags: Array.from({ length: 26 }, (_, i) => ({
        name: `Tag ${i}`,
        tpdb: TAG_A,
      })),
    },
    { hiddenTags: [], extra: true },
  ];
  for (const body of malformed) {
    await errorShape(
      await call("PATCH", "/api/me/preferences", { cookie: member, body }),
    );
  }
  const afterMalformed = await call("GET", "/api/me/preferences", {
    cookie: member,
  });
  const afterMalformedBody = (await afterMalformed.json()) as PreferencesBody;
  assert.deepEqual(afterMalformedBody, {
    hiddenTags: hidden,
    discoverOrder: DEFAULT_ORDER,
  });

  // Both provider references on one tag is the normal cross-provider pick.
  const both = await call("PATCH", "/api/me/preferences", {
    cookie: member,
    body: {
      hiddenTags: [{ name: "Fixture Tag A", tpdb: TAG_A, stashdb: TAG_D }],
    },
  });
  assert.equal(both.status, 200);

  // A label-only hidden tag is legitimate: exclusions run the local family
  // matcher, so no provider id is required.
  const labelOnly = await call("PATCH", "/api/me/preferences", {
    cookie: member,
    body: { hiddenTags: [{ name: "Fixture Tag A" }] },
  });
  assert.equal(labelOnly.status, 200);

  // Restore: tests after this point see the default, unfiltered state.
  const restored = await call("PATCH", "/api/me/preferences", {
    cookie: member,
    body: { hiddenTags: [] },
  });
  assert.equal(restored.status, 200);
});

test("discover honors a personal shelf order; contents, errors, and other accounts stay untouched", async () => {
  try {
    // Member2's untouched view, snapshotted before member's mutations: the
    // followed rail is conditional (present only with follows), so the
    // isolation proof compares against what this account actually has —
    // shelf ids and stored preference document alike.
    const otherBefore = await call("GET", "/api/discover", {
      cookie: member2,
    });
    assert.equal(otherBefore.status, 200);
    const otherShelvesBefore = (await shelvesOf(otherBefore)).map(
      (shelf) => shelf.id,
    );
    const otherPrefsBefore = await call("GET", "/api/me/preferences", {
      cookie: member2,
    });
    assert.equal(otherPrefsBefore.status, 200);
    const otherPrefsBeforeBody =
      (await otherPrefsBefore.json()) as PreferencesBody;

    // The existing endpoint takes an order-only save and answers with the
    // full effective document.
    const custom: string[] = [
      "followed-titles",
      "velvarr-requests",
      "jellyfin-recent",
      "genres",
      "studios",
      "trending",
      "new-releases",
    ];
    const saved = await call("PATCH", "/api/me/preferences", {
      cookie: member,
      body: { discoverOrder: custom },
    });
    assert.equal(saved.status, 200);
    const savedBody = (await saved.json()) as PreferencesBody;
    assert.deepEqual(savedBody.discoverOrder, custom);

    // Absent follow rail: the chosen order applies to the PRESENT shelves
    // only — no fake followed-titles shelf appears, and hiddenTags stays.
    const page = await call("GET", "/api/discover", { cookie: member });
    assert.equal(page.status, 200);
    const shelves = await shelvesOf(page);
    assert.deepEqual(
      shelves.map((shelf) => shelf.id),
      custom.filter((id) => id !== "followed-titles"),
    );

    // Reordering never rewrites contents: the mixed rail stays velvarr-
    // sourced and the requests rail keeps the caller's role-correct view.
    // Member is a moderator at this point (promoted in the removals test),
    // so staff visibility shows the whole request history — owner filings
    // included — not just this account's own.
    const byId = Object.fromEntries(shelves.map((s) => [s.id, s])) as Record<
      string,
      FixtureShelf
    >;
    assert.equal(byId["new-releases"]?.source, "velvarr");
    const staffView = byId["velvarr-requests"]?.items ?? [];
    assert.ok(
      staffView.some((record) => record.accountId === OWNER_ID),
      "moderator rail carries the shared request history",
    );

    // Another account keeps its own view: member's reorder leaks nothing —
    // member2's shelf ids and stored preference document are identical to
    // the pre-mutation snapshot, conditional rails included as-is.
    const other = await call("GET", "/api/discover", { cookie: member2 });
    assert.equal(other.status, 200);
    assert.deepEqual(
      (await shelvesOf(other)).map((shelf) => shelf.id),
      otherShelvesBefore,
    );
    const otherPrefs = await call("GET", "/api/me/preferences", {
      cookie: member2,
    });
    const otherPrefsBody = (await otherPrefs.json()) as PreferencesBody;
    assert.deepEqual(otherPrefsBody, otherPrefsBeforeBody);

    // The absent rail appears at its chosen position once a follow exists.
    const follow = await call("POST", "/api/follows", {
      cookie: member,
      body: {
        performer: {
          provider: "tpdb",
          kind: "performer",
          id: TPDB_PERFORMER,
        },
        name: "Fixture Performer",
      },
    });
    assert.equal(follow.status, 201);
    try {
      const withRail = await call("GET", "/api/discover", { cookie: member });
      assert.deepEqual(
        (await shelvesOf(withRail)).map((shelf) => shelf.id),
        custom,
      );
    } finally {
      const unfollowed = await call(
        "DELETE",
        `/api/follows/tpdb/${TPDB_PERFORMER}`,
        { cookie: member },
      );
      assert.equal(unfollowed.status, 204);
    }

    // Hidden-tags-only save preserves the order; order-only save preserves
    // the tags.
    const tags: TagSelectionBody[] = [{ name: "Fixture Tag A", tpdb: TAG_A }];
    const tagSave = await call("PATCH", "/api/me/preferences", {
      cookie: member,
      body: { hiddenTags: tags },
    });
    assert.equal(tagSave.status, 200);
    const tagSaveBody = (await tagSave.json()) as PreferencesBody;
    assert.deepEqual(tagSaveBody.hiddenTags, tags);
    assert.deepEqual(tagSaveBody.discoverOrder, custom);
    const reorder: string[] = [
      "trending",
      "new-releases",
      "jellyfin-recent",
      "velvarr-requests",
      "studios",
      "genres",
      "followed-titles",
    ];
    const orderSave = await call("PATCH", "/api/me/preferences", {
      cookie: member,
      body: { discoverOrder: reorder },
    });
    assert.equal(orderSave.status, 200);
    const orderSaveBody = (await orderSave.json()) as PreferencesBody;
    assert.deepEqual(orderSaveBody.hiddenTags, tags);
    assert.deepEqual(orderSaveBody.discoverOrder, reorder);

    // The reorder save moves shelves without touching their contents: the
    // requests rail answers with the exact pre-change records (the rail is
    // not hidden-tag filtered, so the active tags cannot shift it either).
    const moved = await call("GET", "/api/discover", { cookie: member });
    assert.equal(moved.status, 200);
    const movedShelves = await shelvesOf(moved);
    assert.deepEqual(
      movedShelves.map((shelf) => shelf.id),
      reorder.filter((id) => id !== "followed-titles"),
    );
    assert.deepEqual(
      movedShelves.find((shelf) => shelf.id === "velvarr-requests")?.items,
      staffView,
    );

    // Invalid and foreign-account mutations are refused with the same
    // invalid_preferences code — and nothing at all changes.
    const rejected: unknown[] = [
      { discoverOrder: ["trending", "trending", ...reorder.slice(2)] },
      { discoverOrder: ["bogus-shelf"] },
      { discoverOrder: "trending" },
      { discoverOrder: [7] },
      { accountId: MEMBER2_ID, discoverOrder: reorder },
    ];
    for (const body of rejected) {
      const err = await errorShape(
        await call("PATCH", "/api/me/preferences", { cookie: member, body }),
      );
      assert.equal(err.code, "invalid_preferences");
    }
    const intact = await call("GET", "/api/me/preferences", { cookie: member });
    const intactBody = (await intact.json()) as PreferencesBody;
    assert.deepEqual(intactBody, { hiddenTags: tags, discoverOrder: reorder });

    // An errored shelf keeps its chosen placement: trending leads even with
    // its only source unconfigured, and the failure rides the shelf itself.
    const key = process.env.STASHDB_API_KEY;
    delete process.env.STASHDB_API_KEY;
    try {
      resetMetaCache();
      const outage = await call("GET", "/api/discover", { cookie: member });
      assert.equal(outage.status, 200);
      const outShelves = await shelvesOf(outage);
      assert.equal(outShelves[0]?.id, "trending");
      assert.equal(outShelves[0]?.error?.code, "provider_not_configured");
      assert.equal(outShelves[0]?.items, undefined);
      assert.deepEqual(
        outShelves.slice(1).map((shelf) => shelf.id),
        reorder.slice(1).filter((id) => id !== "followed-titles"),
      );
    } finally {
      process.env.STASHDB_API_KEY = key;
    }
  } finally {
    // Reset: empty order and empty tags restore the registry order, and
    // tests after this point see the untouched state.
    const reset = await call("PATCH", "/api/me/preferences", {
      cookie: member,
      body: { hiddenTags: [], discoverOrder: [] },
    });
    assert.equal(reset.status, 200);
    const resetBody = (await reset.json()) as PreferencesBody;
    assert.deepEqual(resetBody, {
      hiddenTags: [],
      discoverOrder: DEFAULT_ORDER,
    });
  }
});

test("browse is the unified visible-catalog surface and counts the caller's hidden tags", async () => {
  assert.equal((await call("GET", "/api/browse")).status, 401);
  assert.equal((await call("GET", "/api/browse/tags?q=Fixture")).status, 401);

  const saved = await call("PATCH", "/api/me/preferences", {
    cookie: member,
    body: { hiddenTags: [{ name: "Fixture Tag A", tpdb: TAG_A }] },
  });
  assert.equal(saved.status, 200);
  try {
    resetMetaCache();
    // Movie browse: the title carrying the hidden tag is gone; its untagged
    // sibling survives, and the caller's own list size rides the response.
    const movies = await call("GET", "/api/browse?type=movie", {
      cookie: member,
    });
    assert.equal(movies.status, 200);
    const moviePage = (await movies.json()) as BrowsePageBody;
    assert.equal(moviePage.hiddenTagCount, 1);
    assert.deepEqual(moviePage.errors, []);
    assert.ok(moviePage.items.length > 0, "untagged movies still render");
    for (const item of moviePage.items) {
      assert.notEqual(refOf(item)?.id, TPDB_MOVIE);
    }

    // Mixed browse: the stash side is untouched by a tpdb-scoped tag.
    const all = await call("GET", "/api/browse?type=all", { cookie: member });
    const allPage = (await all.json()) as BrowsePageBody;
    assert.equal(allPage.hiddenTagCount, 1);
    const refs = allPage.items.map(refOf);
    assert.ok(
      refs.some((ref) => ref?.provider === "stashdb" && ref?.kind === "scene"),
    );
    assert.ok(
      refs.every(
        (ref) => !(ref?.provider === "tpdb" && ref?.id === TPDB_MOVIE),
      ),
      "hidden movie never leaks into the mixed page",
    );

    // Explicit URL exclusion on top of the hidden list: excluding the
    // surviving sibling's tag empties the movie page honestly (no items,
    // no error, no fake totals).
    const exclude = encodeURIComponent(
      JSON.stringify([{ name: "Fixture Tag C", tpdb: TAG_C }]),
    );
    const excluded = await call(
      "GET",
      `/api/browse?type=movie&exclude=${exclude}`,
      { cookie: member },
    );
    assert.equal(excluded.status, 200);
    const excludedPage = (await excluded.json()) as BrowsePageBody;
    assert.deepEqual(excludedPage.items, []);
    assert.deepEqual(excludedPage.errors, []);

    // Tag search for the browse filter: provider-published tags with honest
    // per-source errors.
    const tags = await call("GET", "/api/browse/tags?q=Fixture", {
      cookie: member,
    });
    assert.equal(tags.status, 200);
    const tagBody = (await tags.json()) as {
      tags: TagSelectionBody[];
      errors: { provider: string }[];
    };
    assert.deepEqual(tagBody.errors, []);
    assert.ok(tagBody.tags.length > 0, "fixture tags are findable");
    for (const tag of tagBody.tags) {
      assert.equal(typeof tag.name, "string");
      assert.ok(
        tag.tpdb !== undefined || tag.stashdb !== undefined,
        "every picker label carries a provider-native reference",
      );
    }
  } finally {
    const restored = await call("PATCH", "/api/me/preferences", {
      cookie: member,
      body: { hiddenTags: [] },
    });
    assert.equal(restored.status, 200);
  }
});

test("related titles: admission, reference validation before upstream, rank vocabulary", async () => {
  assert.equal(
    (await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE}/related`)).status,
    401,
  );

  // Bad uuid, unknown rank: all refused with no upstream contact at all.
  const before = tpdbFx.calls;
  await errorShape(
    await call("GET", "/api/catalog/tpdb/movie/not-a-uuid/related", {
      cookie: member,
    }),
  );
  await errorShape(
    await call(
      "GET",
      `/api/catalog/tpdb/movie/${TPDB_MOVIE}/related?rank=bogus`,
      { cookie: member },
    ),
  );
  assert.equal(tpdbFx.calls, before, "validation precedes upstream contact");

  // Happy path: tags ranking answers without a TypeSafe key, the source
  // itself never appears in its own list, and per-source errors are honest
  // (none here).
  resetMetaCache();
  const ok = await call(
    "GET",
    `/api/catalog/tpdb/movie/${TPDB_MOVIE}/related`,
    { cookie: member },
  );
  assert.equal(ok.status, 200);
  const related = (await ok.json()) as RelatedBody;
  assert.equal(related.ranking, "tags");
  assert.equal(related.canRank, false);
  assert.deepEqual(related.errors, []);
  assert.ok(Array.isArray(related.items));
  for (const item of related.items) {
    assert.notEqual(refOf(item)?.id, TPDB_MOVIE);
  }

  // jev is a valid explicit choice; with no configured key the response
  // still answers and reports the ranking actually applied.
  const jev = await call(
    "GET",
    `/api/catalog/tpdb/movie/${TPDB_MOVIE}/related?rank=jev`,
    { cookie: member },
  );
  assert.equal(jev.status, 200);
  const jevBody = (await jev.json()) as RelatedBody;
  assert.equal(jevBody.canRank, false);
  assert.equal(jevBody.ranking, "tags");
});

test("performer related answers co-appearances, never the requestability refusal", async () => {
  resetMetaCache();
  const ok = await call(
    "GET",
    `/api/catalog/tpdb/performer/${TPDB_PERFORMER}/related`,
    { cookie: member },
  );
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as {
    items: { title: string; reference: { provider: string; id: string } }[];
    errors: unknown[];
  };
  assert.deepEqual(body.errors, []);
  assert.equal(body.items.length, 1);
  const partner = body.items[0]!;
  assert.equal(partner.title, "Dee Vine");
  assert.equal(partner.reference.id, TPDB_PERFORMER4);
  // The performer herself never appears in her own rail.
  assert.notEqual(partner.reference.id, TPDB_PERFORMER);

  // A hidden tag on the partner's credit row removes the co-appearance
  // rather than rendering the hidden title's evidence.
  const saved = await call("PATCH", "/api/me/preferences", {
    cookie: member,
    body: {
      hiddenTags: [{ name: "Fixture Tag A", tpdb: TAG_A }],
    },
  });
  assert.equal(saved.status, 200);
  try {
    resetMetaCache();
    const filtered = await call(
      "GET",
      `/api/catalog/tpdb/performer/${TPDB_PERFORMER}/related`,
      { cookie: member },
    );
    assert.equal(filtered.status, 200);
    const filteredBody = (await filtered.json()) as typeof body;
    assert.deepEqual(filteredBody.items, []);
  } finally {
    const restore = await call("PATCH", "/api/me/preferences", {
      cookie: member,
      body: { hiddenTags: [] },
    });
    assert.equal(restore.status, 200);
  }
});

test("hidden tags filter discover, global search, and filmography — never entities or owned history", async () => {
  const saved = await call("PATCH", "/api/me/preferences", {
    cookie: member,
    body: { hiddenTags: [{ name: "Fixture Tag A", tpdb: TAG_A }] },
  });
  assert.equal(saved.status, 200);
  // Follow the performer whose whole fixture filmography carries the hidden
  // tag: the followed rail has nothing left to show, so it must disappear
  // rather than render blocked titles.
  const follow = await call("POST", "/api/follows", {
    cookie: member,
    body: {
      performer: {
        provider: "tpdb",
        kind: "performer",
        id: TPDB_PERFORMER,
      },
      name: "Fixture Performer",
    },
  });
  assert.equal(follow.status, 201);
  try {
    resetMetaCache();

    // Discover: the mixed rail drops the hidden title, and the genre facet
    // loses its tile — blocked artwork cannot reappear as facet art. The
    // sibling tiles and the trending rail still render. The followed rail
    // vanishes entirely: every title it could carry is hidden.
    const page = await call("GET", "/api/discover", { cookie: member });
    assert.equal(page.status, 200);
    const shelves = await shelvesOf(page);
    const byId = new Map(shelves.map((shelf) => [shelf.id, shelf]));
    for (const item of byId.get("new-releases")?.items ?? []) {
      assert.notEqual(refOf(item)?.id, TPDB_MOVIE);
    }
    const genreTiles = (byId.get("genres")?.items ?? []) as FacetTile[];
    for (const tile of genreTiles) {
      assert.notEqual(tile.id, TAG_A, "hidden tag cannot resurface as art");
    }
    assert.ok(genreTiles.some((tile) => tile.id === TAG_C));
    assert.ok((byId.get("trending")?.items?.length ?? 0) > 0);
    assert.equal(
      shelves.some((shelf) => shelf.id === "followed-titles"),
      false,
      "a fully hidden filmography renders no followed rail",
    );

    // Preference is a filter, not authorization: the hidden title's detail
    // stays accessible and owned request history keeps flowing.
    const detail = await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE}`, {
      cookie: member,
    });
    assert.equal(detail.status, 200);
    assert.ok((byId.get("velvarr-requests")?.items?.length ?? 0) > 0);

    // Global search: the movie category filters; entity categories stay raw.
    const search = await call("GET", "/api/search?q=Fixture", {
      cookie: member,
    });
    const body = await searchOf(search);
    const moviesCat = body.categories.find(
      (category) => category.id === "tpdb-movies",
    );
    for (const item of moviesCat?.items ?? []) {
      assert.notEqual(item.reference.id, TPDB_MOVIE);
    }
    const performersCat = body.categories.find(
      (category) => category.id === "tpdb-performers",
    );
    assert.ok(
      (performersCat?.items.length ?? 0) > 0,
      "performer search stays raw",
    );
    const studiosCat = body.categories.find(
      (category) => category.id === "tpdb-studios",
    );
    assert.ok((studiosCat?.items.length ?? 0) > 0, "studio search stays raw");

    // Performer filmography through the media catalog search: the hidden
    // title disappears for THIS account…
    const filmography = await call(
      "GET",
      `/api/catalog/search?provider=tpdb&kind=movie&performer=${TPDB_PERFORMER}`,
      { cookie: member },
    );
    assert.equal(filmography.status, 200);
    const film = (await filmography.json()) as { items: FacetTile[] };
    for (const item of film.items) {
      assert.notEqual(refOf(item)?.id, TPDB_MOVIE5);
    }

    // …and only for this account: the same filmography still carries the
    // title for an account without the hidden tag. Fresh metadata cache so
    // the sibling read cannot ride this account's filtered page.
    resetMetaCache();
    const otherFilmography = await call(
      "GET",
      `/api/catalog/search?provider=tpdb&kind=movie&performer=${TPDB_PERFORMER}`,
      { cookie: member2 },
    );
    assert.equal(otherFilmography.status, 200);
    const otherFilm = (await otherFilmography.json()) as {
      items: FacetTile[];
    };
    assert.ok(
      otherFilm.items.some((item) => refOf(item)?.id === TPDB_MOVIE5),
      "the hidden-tag filter is personal, never global",
    );
  } finally {
    const unfollowed = await call(
      "DELETE",
      `/api/follows/tpdb/${TPDB_PERFORMER}`,
      { cookie: member },
    );
    assert.equal(unfollowed.status, 204);
    const restored = await call("PATCH", "/api/me/preferences", {
      cookie: member,
      body: { hiddenTags: [] },
    });
    assert.equal(restored.status, 200);
  }
});

test("hidden tag families: a whole-word label hides longer-tagged titles on every personal surface", async () => {
  // Phase 1 reuses the shared snapshot rows: the saved label "Fixture Tag"
  // is a whole-word prefix of "Fixture Tag A" and "Fixture Tag C" but NOT
  // of "Fixture Stash Tag" ([fixture, tag] is not a contiguous word
  // sequence inside [fixture, stash, tag]) — so discover and global search
  // prove family hiding against data every other test already relies on.
  const saved = await call("PATCH", "/api/me/preferences", {
    cookie: member,
    body: { hiddenTags: [{ name: "Fixture Tag", tpdb: TAG_A }] },
  });
  assert.equal(saved.status, 200);
  try {
    resetMetaCache();

    // Discover: every TPDB movie leaves the mixed rail — under exact-only
    // matching the "Fixture Tag C" row would survive — and the StashDB
    // side still renders.
    const discover = await call("GET", "/api/discover", { cookie: member });
    assert.equal(discover.status, 200);
    const shelves = await shelvesOf(discover);
    const releaseRefs = (
      shelves.find((shelf) => shelf.id === "new-releases")?.items ?? []
    ).map(refOf);
    assert.ok(
      releaseRefs.every(
        (ref) => !(ref?.provider === "tpdb" && ref?.kind === "movie"),
      ),
      "a whole-word label hides the longer-tagged title on discover",
    );
    assert.ok(
      releaseRefs.some(
        (ref) => ref?.provider === "stashdb" && ref?.kind === "scene",
      ),
      "a tpdb-scoped hidden label never touches the stash side",
    );

    // Global search: the movie category loses the family rows, the scene
    // category keeps its non-contiguous label.
    const search = await call("GET", "/api/search?q=Fixture", {
      cookie: member,
    });
    const searchBody = await searchOf(search);
    const moviesCat = searchBody.categories.find(
      (category) => category.id === "tpdb-movies",
    );
    assert.ok(
      (moviesCat?.items ?? []).every(
        (item) => item.reference.id !== TPDB_MOVIE9,
      ),
      "a whole-word label hides the longer-tagged title in global search",
    );
    const scenesCat = searchBody.categories.find(
      (category) => category.id === "stashdb-scenes",
    );
    assert.ok(
      (scenesCat?.items ?? []).some(
        (item) => item.reference.id === STASH_SCENE,
      ),
      "a label that is not a contiguous word sequence never matches",
    );

    // …and only for this account: the family-hidden title renders again
    // for an account without the hidden tag.
    resetMetaCache();
    const otherDiscover = await call("GET", "/api/discover", {
      cookie: member2,
    });
    assert.equal(otherDiscover.status, 200);
    const otherRefs = (
      (await shelvesOf(otherDiscover)).find(
        (shelf) => shelf.id === "new-releases",
      )?.items ?? []
    ).map(refOf);
    assert.ok(
      otherRefs.some((ref) => ref?.id === TPDB_MOVIE9),
      "family hiding is personal, never global",
    );
  } finally {
    const restored = await call("PATCH", "/api/me/preferences", {
      cookie: member,
      body: { hiddenTags: [] },
    });
    assert.equal(restored.status, 200);
  }

  // Phase 2 uses the dedicated family rows: exact parent "Anal", whole-word
  // child "Anal Creampie", and "Analingus" — a letter overlap with no word
  // boundary. Served only for q=Family and the family filmography route.
  const savedAnal = await call("PATCH", "/api/me/preferences", {
    cookie: member,
    body: { hiddenTags: [{ name: "Anal", tpdb: TAG_FAMILY_PARENT }] },
  });
  assert.equal(savedAnal.status, 200);
  try {
    resetMetaCache();

    // Browse: the child-tagged title leaves the page beside its parent, the
    // boundary-tagged title stays, the count still reports exactly one
    // saved hidden selection, and the stash side is untouched.
    const browse = await call("GET", "/api/browse?q=Family", {
      cookie: member,
    });
    assert.equal(browse.status, 200);
    const browsePage = (await browse.json()) as BrowsePageBody;
    assert.equal(browsePage.hiddenTagCount, 1);
    assert.deepEqual(browsePage.errors, []);
    const browseRefs = browsePage.items.map(refOf);
    assert.ok(
      browseRefs.every(
        (ref) =>
          ref?.id !== TPDB_MOVIE_FAMILY_EXACT &&
          ref?.id !== TPDB_MOVIE_FAMILY_CHILD,
      ),
      "a whole-word label hides the longer-tagged title on browse",
    );
    assert.ok(
      browseRefs.some(
        (ref) => ref?.provider === "tpdb" && ref?.id === TPDB_MOVIE_FAMILY_WIDE,
      ),
      "a letter overlap with no word boundary never matches",
    );
    assert.ok(
      browseRefs.some(
        (ref) => ref?.provider === "stashdb" && ref?.kind === "scene",
      ),
      "the stash side is untouched by a tpdb-scoped family label",
    );

    // Global search on the same q marker: same split.
    const familySearch = await call("GET", "/api/search?q=Family", {
      cookie: member,
    });
    const familySearchBody = await searchOf(familySearch);
    const familyMovies = familySearchBody.categories.find(
      (category) => category.id === "tpdb-movies",
    );
    assert.ok(
      (familyMovies?.items ?? []).every(
        (item) =>
          item.reference.id !== TPDB_MOVIE_FAMILY_EXACT &&
          item.reference.id !== TPDB_MOVIE_FAMILY_CHILD,
      ),
      "a whole-word label hides the longer-tagged title in global search",
    );
    assert.ok(
      (familyMovies?.items ?? []).some(
        (item) => item.reference.id === TPDB_MOVIE_FAMILY_WIDE,
      ),
      "the boundary-tagged title stays visible in global search",
    );

    // Filmography through the media catalog search: same family rule.
    const filmography = await call(
      "GET",
      `/api/catalog/search?provider=tpdb&kind=movie&performer=${TPDB_PERFORMER_FAMILY}`,
      { cookie: member },
    );
    assert.equal(filmography.status, 200);
    const film = (await filmography.json()) as { items: FacetTile[] };
    const filmRefs = film.items.map(refOf);
    assert.ok(
      filmRefs.every(
        (ref) =>
          ref?.id !== TPDB_MOVIE_FAMILY_EXACT &&
          ref?.id !== TPDB_MOVIE_FAMILY_CHILD,
      ),
      "a whole-word label hides the longer-tagged filmography row",
    );
    assert.ok(
      filmRefs.some((ref) => ref?.id === TPDB_MOVIE_FAMILY_WIDE),
      "the boundary-tagged filmography row stays visible",
    );

    // …and only for this account.
    resetMetaCache();
    const otherBrowse = await call("GET", "/api/browse?q=Family", {
      cookie: member2,
    });
    assert.equal(otherBrowse.status, 200);
    const otherPage = (await otherBrowse.json()) as BrowsePageBody;
    assert.equal(otherPage.hiddenTagCount, 0);
    const otherIds = otherPage.items.map((item) => refOf(item)?.id);
    for (const id of [
      TPDB_MOVIE_FAMILY_EXACT,
      TPDB_MOVIE_FAMILY_CHILD,
      TPDB_MOVIE_FAMILY_WIDE,
    ]) {
      assert.ok(otherIds.includes(id), `visible without the hidden tag: ${id}`);
    }
  } finally {
    const restored = await call("PATCH", "/api/me/preferences", {
      cookie: member,
      body: { hiddenTags: [] },
    });
    assert.equal(restored.status, 200);
  }

  // Phase 3: explicit URL filters against the same rows, no hidden list.
  resetMetaCache();

  // exclude=[parent] drops the child-tagged rows through the same family
  // rule, and is honest that the personal hidden list played no part.
  const exclude = encodeURIComponent(
    JSON.stringify([{ name: "Anal", tpdb: TAG_FAMILY_PARENT }]),
  );
  const excluded = await call(
    "GET",
    `/api/browse?q=Family&type=movie&exclude=${exclude}`,
    { cookie: member },
  );
  assert.equal(excluded.status, 200);
  const excludedPage = (await excluded.json()) as BrowsePageBody;
  assert.equal(excludedPage.hiddenTagCount, 0);
  const excludedRefs = excludedPage.items.map(refOf);
  assert.ok(
    excludedRefs.every(
      (ref) =>
        ref?.id !== TPDB_MOVIE_FAMILY_EXACT &&
        ref?.id !== TPDB_MOVIE_FAMILY_CHILD,
    ),
    "an explicit exclude drops the whole-word family rows",
  );
  assert.ok(
    excludedRefs.some((ref) => ref?.id === TPDB_MOVIE_FAMILY_WIDE),
    "an explicit exclude still never matches a letter overlap",
  );

  // include=[parent] stays exact: the filmography path applies includes
  // locally, so a widened predicate would invent child-only rows here.
  const include = encodeURIComponent(
    JSON.stringify([{ name: "Anal", tpdb: TAG_FAMILY_PARENT }]),
  );
  const included = await call(
    "GET",
    `/api/browse?performerTpdb=${TPDB_PERFORMER_FAMILY}&include=${include}`,
    { cookie: member },
  );
  assert.equal(included.status, 200);
  const includedPage = (await included.json()) as BrowsePageBody;
  assert.deepEqual(
    includedPage.items.map((item) => refOf(item)?.id),
    [TPDB_MOVIE_FAMILY_EXACT],
    "an include never invents rows tagged only with a family child",
  );
});
