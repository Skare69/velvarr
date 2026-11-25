# Spec: Merge duplicate TPDB movies inside Velvarr

Card VELV-297, sub-task of VELV-288. TPDB can hold two records for one
release. The duplicate check (`src/server/duplicates.ts`) already names the
pair. This feature lets a granted user merge the pair inside Velvarr, so
Velvarr shows one entry while TPDB still holds two records. TPDB's own merge
stays the parent card's scope.

## Decisions (user answers, 2026-11-24)

- Permission: a new per-account grant, "Merge duplicates" (same shape as the
  auto-approve and prose-search grants). Admins always may merge.
- Scope: Velvarr-wide. One merge changes what every user sees.
- Primary record: the user picks in the merge dialog. Smart default: the
  record with a library file; a tie or no files falls to the older release
  date. A full tie falls to the lower id, so the default is deterministic.
- Undo: Unmerge on the primary's detail page, and in the duplicate notice.
- Visibility: everywhere. A merged-away id resolves to the primary at read
  time. Stored rows keep their stored ids, so an undo restores them.

## Behavior

### The merge link

- Migration 17 adds:
  - `accounts.merge_duplicates INTEGER NOT NULL DEFAULT 0
    CHECK (merge_duplicates IN (0, 1))`.
  - Table `movie_merges`: `merged_id TEXT PRIMARY KEY`, `primary_id TEXT
    NOT NULL`, `created_by TEXT NOT NULL REFERENCES accounts (id)`,
    `created_at INTEGER NOT NULL`, plus an index on `primary_id`.
- Ids are stored lowercase (migration 16's fold rule).
- Invariant: `primary_id` is never itself a `merged_id` (no chains). A merge
  whose primary is already merged away is refused.
- Dependent merges are refused: when the merged-away id is currently the
  primary of existing links, the write fails with 400 `dependent_merge` and
  stores nothing; the user unmerges those links first.
- Write path: TPDB must return both details before the link is stored. An
  upstream failure names the source and stores nothing. A successful merge or
  undo calls `clearDiscoverCache()`.
- Session recheck: the merge write re-derives the session and the grant just
  before the write, after both upstream reads. The route's admission snapshot
  predates the body read and the reads; logout during them deletes the
  session row, so a revoked session refuses the write with 401
  `session_expired` before anything is stored. The live-account grant check
  follows it unchanged.
- Unmerge deletes the one link row. No other state changes, so every stored
  reference reads the old way again.

### Routes (in `routes/catalog.ts`)

- `POST /api/catalog/tpdb/movie/:id/merge`, body `{ primary: MediaReference }`.
  `:id` is the merged-away record. Both refs must be TPDB movie UUIDs and
  must differ. Returns 201 `{ mergedId, primaryId }`.
- `DELETE /api/catalog/tpdb/movie/:id/merge`. Removes the link whose
  `merged_id` is `:id`. Returns 200 `{ removed: true }`; no such link is 404
  `not_found`.
- Both routes: session auth, then the grant check — role `admin` or
  `account.mergeDuplicates`, else 403 `forbidden`.

### Read-time resolution

- Detail: `GET /api/catalog/tpdb/movie/:id` with a merged-away id returns the
  primary's detail. Every TPDB movie detail carries `mergedFromIds: string[]`
  (ids merged into this record) when the list is non-empty.
- Listings: browse, search, discover rails, related rails and filmographies
  drop TPDB movie rows whose id is merged away. The drop sits at one shared
  point in the TPDB listing path in `src/server/providers.ts`. The primary
  still appears (both records exist upstream). Drops happen inside the
  pagination walk itself (filtering-aware pagination, bounded), so a page
  keeps filling after drops; a source whose rows were dropped reports its
  total as unknown.
- Requests: `GET /api/requests` resolves each row's `media` reference at read
  time. The active-request and shared-acquisition identity lookups walk the
  full merge group of the asked id, own id first, so a row stored under any
  group id answers, and a second active request for any group id is refused
  with 409 `request_exists`. Stored rows stay untouched; titles and decisions
  keep their stored snapshots.
- Library: a `LibraryItem` whose `catalog` reference is a merged-away TPDB
  movie resolves to the primary at read time. Library and the Jellyfin-recent
  rail group display by canonical identity, so a merged pair never shows as
  two entries. The grouping helper takes raw items and resolves the catalog
  references itself. Within a group the first item holds the slot, and a
  later item filed under the kept record itself (its original catalog id
  equals the group key) replaces the slot exactly once, so the kept record's
  tile wins whichever order Jellyfin returns; an alias-only group still names
  the kept record. While at least one merge exists, the library route
  enumerates the Jellyfin items across pages, groups the raw list, and
  serves the requested window with the grouped total, so a pair split across
  pages still renders one tile; with no merges the single-page fetch is
  unchanged. The Jellyfin-recent rail stays one fetch — grouping within the
  fetched window is its honest bound.
- Duplicates check: a candidate already merged away carries `mergedInto` (the
  primary id) in the response. The merge filter stays out of the check's own
  candidate path, so a merged pair stays visible for undo.

### Wire changes (`src/lib/contracts.ts`)

- `Account.mergeDuplicates: boolean`; `AdminAccount` inherits it.
- `CatalogDetail.mergedFromIds?: string[]` — present when non-empty.
- `DuplicateMovieMatch.mergedInto?: string` — present when the candidate is
  merged away.

### UI

- Duplicate notice (`src/components/movie-duplicates.tsx`): users with the
  grant see a "Merge in Velvarr" action. The picker shows both records; the
  default follows the smart rule. The availability read of both records
  decides "has a library file". Users without the grant see no merge action.
- A match with `mergedInto` equal to the opened record shows "Merged in
  Velvarr" with Unmerge. A `mergedInto` that points at another record
  renders as read-only text.
- The primary's detail page lists merged-away ids with an Unmerge button
  (grant-gated) in `src/components/catalog-detail.tsx`.
- Admin users dialog (`src/components/admin.tsx`): a "Merge duplicates"
  checkbox beside the natural-language search one, disabled for owner and
  admins, with the same copy style as the existing grants.
- The notice keeps its TPDB report links and Copy report. A merge never
  hides them.

## Boundaries and error cases

- Error codes: 400 `self_merge`, 400 `already_merged`, 400 `primary_merged`,
  400 `dependent_merge`, 400 `invalid_field` (bad body refs), 400
  `invalid_reference` (not a TPDB movie), 401 `session_expired` (logout
  during the upstream reads), 403 `forbidden`, 404 `not_found` on an unknown
  undo. Upstream failures pass through with their named source error.
- A merged-away id in a URL still resolves on detail and disappears from
  lists; a merge alone never produces a 404.
- Undo works while TPDB still holds both records.

## Acceptance checks

- `tests/api.test.ts`: POST links two ids; GET detail of the merged-away id
  returns the primary's detail with `mergedFromIds`; DELETE removes the link
  and the merged-away id resolves itself again; 403 without the grant; 400
  self-merge; the requests list resolves a merged-away media reference at
  read time, and an undo restores it.
- Gates: `bun run format`, `bun run check`, `bun run test`, `bun run build`.
- Browser proof under `shots/`: the duplicate notice with the Velvarr merge
  action, and the merged result with Unmerge.

## Non-goals

- No TPDB-side report or merge (parent card VELV-288).
- No rewrite of stored request, acquisition or Whisparr rows; they resolve at
  read time only.
- No name-based matching. A merge is always an explicit user assertion.
- No chain merges (A→B→C): refuse, undo first.

## Alternatives considered

- Per-account merge table (like follows): rejected — the user chose
  Velvarr-wide; per-user repeats every merge for each member.
- Chain merges with resolution loops: rejected — the one-hop invariant keeps
  every read a single indexed lookup and needs no cycle guard.
- Rewrite stored rows on merge: rejected — an undo could not restore them;
  the user chose read-time resolution.
- Auto-picked primary without a dialog: rejected — the user chose a picker
  with a smart default, which also covers both-have-files and
  neither-have-files cases.

## Risks

- The listing filter widens the blast radius of one merge to every surface.
  Mitigation: one shared filter at the providers.ts chokepoint, pinned by a
  route-level test.
- Cached discover rails can show a merged-away tile until a refresh.
  Mitigation: merge writes call `clearDiscoverCache()`; provider meta caches
  stay TTL-bound and can delay a tile, never a detail.
- A forged merge call could pair arbitrary ids. Mitigation: both details must
  come back from TPDB before the link is stored.
