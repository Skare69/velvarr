# Possible duplicate TPDB movies

## Goal and boundaries

Detect possible duplicate TPDB movie records, including translated releases. Show a notice on the movie detail page and prepare a manual report. Never submit reports to TPDB.

Only TPDB movies qualify. Keep both records in all lists. Do not add scene support, StashDB support, list-page detection, background scans, stored pairs, badges, or a report history. Titles and studios are not match signals.

## API and candidates

Add session-authenticated `GET /api/catalog/:provider/:kind/:id/duplicates`. Accept only `tpdb/movie` and a UUID. Other combinations or invalid IDs return 400 through the existing error contract. A missing current movie returns 404.

Reuse the provider HTTP layer and the existing TPDB credential. Never send that credential to an image host or the browser. Read `/movies/{id}` for the current record and its hashes.

For metadata candidates, request one page of `/movies?performer_id=<id>&year=<year>&per_page=100`. Use the first credited performer with a positive numeric parent `_id`, in provider order. Use the release year, not a record timestamp. If either field is absent, skip this query and name each missing field in `incomplete`.

For hash candidates, deduplicate by type and lowercased hash. Query the first five distinct hashes in provider order with `/movies?hash=<hash>&hash_type=<type>&per_page=100`. Allow only OSHASH and PHASH. If more hashes exist, report `checked 5 of N hashes`. Empty or invalid hashes are not evidence.

Do not crawl pagination. When a query has another page, report that the candidate search covers only its first page. Candidate discovery is bounded and can miss pairs. In particular, a subset cast without the selected performer cannot appear through that metadata query.

Exclude the current UUID without regard to case. Deduplicate candidates by UUID. Apply the caller's hidden-tag matcher before poster work, output, or candidate-specific errors. Hidden candidates must not appear in reports or messages.

## Match rules

A pair qualifies under either rule. Report every rule that the check establishes.

### Hash

The two records share an exact hash of the same type, without regard to letter case. OSHASH and PHASH do not match across types. This rule does not require metadata or posters.

### Metadata

All conditions must hold:

- Both canonical performer ID sets are non-empty. One set fully contains the other. Use the provider mapper's canonical parent-ID fallback.
- Both valid release dates have the same calendar year.
- Both unique TPDB tag-ID sets are non-empty. The shared count divided by the smaller count is at least 0.5.
- If both positive durations exist, `abs(a-b) / max(a,b)` is at most 0.1. A missing duration does not veto a match.
- Poster dHash distance is at most 10 bits out of 64.

Use the mapped detail `imageUrl` as the poster. Use `sharp`: convert to greyscale, resize to 9 by 8 with `fit: "fill"`, then compare adjacent pixels. Each bit is one when the left pixel is brighter than the right. Use row order for the 64 bits. Apply decode pixel limits, HTTP byte limits, and deadlines. Use the existing image allowlist and reject redirects. Do not fetch arbitrary studio images.

Run poster work only after the other metadata checks pass. Compare at most ten candidates. Sort by shared performer count descending, tag overlap descending, then UUID ascending. If the cap applies, report `posters compared for 10 of N candidates`.

If a poster fails or is absent, report the actual comparison count instead of ten. Repeated candidate rows retain all verified hash evidence.

A missing candidate poster fails metadata and adds an incomplete reason with its title and UUID. A poster fetch or decode failure fails metadata and adds a sanitized TPDB image error with the candidate identity. If the current poster is missing or fails, add `Duplicate check incomplete: poster unavailable`. Also add an error for fetch or decode failures. Preserve hash matches.

## Response

Add `DuplicateMoviesResponse` and `DuplicateMovieMatch` to the shared contracts:

```ts
type DuplicateMovieMatch = {
  reference: CatalogReference;
  title: string;
  releaseDate?: string;
  durationSeconds?: number;
  studio?: string;
  tpdbUrl: string;
  rules: Array<"hash" | "metadata">;
  evidence: {
    sharedHashes?: { type: "OSHASH" | "PHASH"; hash: string }[];
    sharedPerformerIds?: string[];
    tagOverlap?: number;
    posterDistance?: number;
  };
};
type DuplicateMoviesResponse = {
  selfUrl: string;
  matches: DuplicateMovieMatch[];
  incomplete: string[];
  errors: SourceError[];
};
```

Use public `https://theporndb.net/movies/<UUID>` links. A failed candidate query adds a named source error and preserves other results. Invalid upstream payloads are failures, not clean empty results. Unexpected local faults retain the existing error boundary.

## Detail notice and report

Fetch the route after the detail loads, independently of playback and request actions. Only mount it on TPDB movie details. Every signed-in user can use it.

Each match shows `Possible TPDB duplicate: <title> (<year>)`, both TPDB links, its rules, and a `Copy report` button. Omit the year when absent. Copy plain text with both titles, UUIDs, links, rules, and evidence. Explain that the user submits the report on TPDB. Confirm copy success. Show clipboard failure without claiming success.

Show one `Duplicate check unavailable: <source error>` line for each error. Show each incomplete reason. Preserve matches beside these messages. A complete check without matches shows nothing. Do not replace a failed check with a clean empty result.

## Acceptance

- API fixtures prove translated metadata matches, exact OSHASH and PHASH matches, cross-type hash rejection, and both rules together.
- Negative cases cover disjoint casts, empty casts, different years, missing dates, insufficient tags, empty tags, excess duration difference, poster distance above ten, and failed posters.
- Check the exact boundaries: 50 percent tags, 10 percent duration, and ten poster bits pass.
- Check UUID self-exclusion, candidate deduplication, hidden tags, five-of-six distinct hashes, poster caps, and bounded pagination.
- Check session admission, unsupported providers and kinds, invalid UUIDs, and missing current movies.
- A failed candidate source preserves other matches and returns named errors. Malformed responses never imply a complete empty result.
- Test the pure rules and image hashing with synthetic images, including resized and re-encoded copies. Use fixed-seed fast-check properties for symmetry and input normalization invariants.
- Browser proof covers the notice, both links, actual clipboard text, clean state, partial failure, and named errors. Save screenshots under `shots/`.
- Run the project format, type, test, build, and security checks. Skip mutation testing in this work turn under the board rule.
- Update the README and existing feature documentation. Run `bun run readme-screenshot` if available. If absent, report that limit rather than invent a success.

## Live prerequisite evidence and assumptions

The authenticated read-only probe succeeded before implementation. The combined movie query returned the seed record with the correct performer and year. A year-only control returned 100 movies, with only one performer match. The performer-only control returned one matching movie. The alternate-year query excluded the seed.

Both UUID and slug movie pages redirected to TPDB's sign-in page. The official TPDB Jellyfin plugin defines `MovieURL` as `https://theporndb.net/movies/{0}`:
https://github.com/ThePornDatabase/Jellyfin.Plugin.ThePornDB/blob/52780f36/Jellyfin.Plugin.ThePornDB/Consts.cs

The public page body needs a TPDB website session. This feature does not introduce one.

Use the configured TPDB token, as the gate assumed. The provisioned environment supplies it. The probe printed only status, field names, and aggregate checks, never the credential or movie titles.

The original idea named scenes. The refined user decision explicitly selects movies. Poster limits and deterministic ordering implement the bounded check from the refined spec, not an exhaustive duplicate search.
