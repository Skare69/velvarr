# Performer match suggestions

## Goal and boundaries

A performer page that shows only one provider (TPDB or StashDB) offers the
probable record on the other provider. Velvarr compares the published facts of
both records and shows a score with the evidence. The user confirms each merge
with one click. Velvarr never merges on its own.

The existing link-based identity stays unchanged: an explicit provider URL, a
single candidate with a shared profile link (`linkedPerformerCounterpart`), or
the account's own merge. Suggestions never change that verdict.

Non-goals: background scans, stored suggestions, Velvarr-wide merges (the
merge stays per account, through follows), image similarity, and
country/nationality comparison (StashDB stores a country code, TPDB stores a
free-text nationality and birthplace, so they cannot be compared honestly).

## API

Session-authenticated `GET /api/catalog/:provider/:kind/:id/matches`.

- Only `kind = performer`. Other kinds return 400 `invalid_reference`. An
  invalid provider or id returns 400 through the existing parser.
- A missing performer returns 404 `catalog_not_found`.
- When the performer already has a counterpart (provider link, auto link, or
  the account's own merge), the answer is `{ suggestions: [], searched: [],
  incomplete: [], errors: [] }` with no search.

```ts
type PerformerMatchSignal = {
  key: "linksBack" | "profileLink" | "name" | "birthDate" | "deathDate"
     | "gender" | "height" | "eyeColor" | "hairColor" | "ethnicity"
     | "careerStart" | "cupSize";
  verdict: "match" | "conflict";
  label: string;   // plain English, for example "Born 1990-05-04 on both"
  points: number;  // signed contribution to the score
};
type PerformerMatchSuggestion = {
  reference: CatalogReference;   // the other provider's performer
  title: string;
  imageUrl?: string;
  aliases: string[];             // at most 5
  score: number;                 // 0..100
  confidence: "high" | "medium" | "low";
  signals: PerformerMatchSignal[];
};
type PerformerMatchesResponse = {
  suggestions: PerformerMatchSuggestion[];
  searched: string[];            // the name queries sent to the other provider
  incomplete: string[];          // honest bounds of the check
  errors: SourceError[];         // named failures; other results stay
};
```

## Candidates

1. Queries: the performer's title, then its first two aliases. Deduplicate the
   queries by normalized name (below). Skip empty ones.
2. Each query runs one `searchCatalog` page on the other provider (TPDB
   `perPage: 10`; StashDB has no paging). A failed query adds
   `sourceError(other, err)` and the other queries continue.
3. Deduplicate result references by id, in query order. Skip the performer
   itself. Read at most 10 candidate details with `getCatalogDetail`. When
   more than 10 exist, add `Compared the first 10 of N <Other> search results`
   to `incomplete`. A null detail is skipped. A failed detail read adds a
   source error and the others continue.
4. Score each candidate (below). Keep a candidate when it has no hard
   conflict and its score is at least 40. Sort by score descending, then by
   id ascending. Return at most 5.

## Scoring

Pure function `scorePerformerMatch(subject, candidate)` in
`src/server/performer-match.ts`. It returns
`{ score, confidence, signals, hardConflict }`. A signal exists only when both
records publish the compared field. Absent fields are never evidence.

Normalized name: NFKD, diacritics removed, lowercase, every run of
non-alphanumeric characters becomes one space, trimmed.

| key | match | conflict |
| --- | --- | --- |
| `linksBack` | the candidate's own `crossProviderLink` names the subject: +100 | — |
| `profileLink` | n shared `identityLinkKey` keys: 40 + 10·(n−1), max 60 | — |
| `name` | equal normalized titles: +25; else any title or alias equal: +15 | — |
| `birthDate` | equal at the shared precision: day +40, month +25, year +10 | different: −60 |
| `deathDate` | equal at the shared precision: +15 | different: −30 |
| `gender` | equal after normalization: +5 | different: −100 and hard conflict |
| `height` | difference ≤ 3 cm: +10 | difference > 8 cm: −25 |
| `eyeColor` | equal: +5 | different: −10 |
| `hairColor` | equal: +3 | — (hair is dyed) |
| `ethnicity` | equal after synonyms: +5 | different, both in the StashDB set: −10 |
| `careerStart` | difference ≤ 1 year: +5 | difference ≥ 5 years: −5 |
| `cupSize` | equal letters: +3 | — |

- Shared precision: the lower of the two accuracies (`year` < `month` <
  `day`; a missing accuracy counts as `day`). Compare the first 4, 7 or 10
  characters of the ISO date.
- Gender normalization: lowercase, "transgender" becomes "trans", spaces and
  underscores are removed ("Transgender Female" = "Trans Female").
- Ethnicity synonyms: white → caucasian, ebony → black, latina, latino and
  hispanic → latin. StashDB set: caucasian, black, asian, indian, latin,
  middle eastern, mixed, other.
- Cup size compares the uppercase letters only ("34D" and "D" match).
- Score: the sum, clamped to 0..100. Confidence: high ≥ 80, medium ≥ 55,
  otherwise low.

## Merge

The suggestion's Merge button posts the existing
`POST /api/follows/merge` with `performer` = the opened record and
`counterpart` = the suggestion. The merge now follows both sides when they are
not followed yet. The snapshot comes from the provider detail with the same
rules as a Follow press. A missing counterpart detail returns 404
`catalog_not_found`. Every refusal rolls back both new rows.

Behavior change: the merge no longer refuses with `follow_not_found` when the
counterpart is not followed.

The page merges details as before: the opened record wins every field it has,
and the other record only fills the gaps (`mergePerformerDetails`).

## UI

On the performer page, the panel for the missing provider shows "Possible
<Other> matches" above the manual merge control while the read runs or when it
finds suggestions. Each suggestion shows the photo, the name (a link to its
page), the score and confidence, the match and conflict signals, and a Merge
button. A text says that Velvarr compares published facts and that a merge
records the user's choice. Errors and `incomplete` notes show below the list.
No suggestions and no errors: the section shows nothing.

## Acceptance

- Unit tests for `scorePerformerMatch` with matching and non-matching pairs:
  birth date precision, gender hard conflict, links back, shared profile
  links, alias names, clamping, confidence bands.
- API tests: a TPDB performer with no link gets the StashDB candidate offered,
  and the reverse. A candidate with a different gender is not offered.
  Non-performer kinds give 400. A linked performer gives an empty answer.
- API test: a merge with an unfollowed counterpart follows both and links them.
- The existing duplicate and follow tests pass.
