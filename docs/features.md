# Features

- **Catalogs:** movies (TPDB), scenes (TPDB and StashDB), performers, and studios, with the filters and sort orders that each provider supports.
- **Artwork:** StashDB uses the servable image with the largest valid pixel area. If no servable image has valid dimensions, it uses the first servable image.
- **Browse:** one grid for TPDB movies and StashDB scenes, with search, tag include and exclude ("or" groups included), up to five performers with an all-or-any choice, up to five studios, a year range, and date filters. A filter an entry cannot ride on one source says so in a note beside the grid. The URL holds every filter.
- **Search, Studios, and Genres** across both providers. Velvarr never merges results across providers. Cross-provider identity comes only from links that the providers publish.
- **Requests** with administrator or moderator approval, and an optional auto-approve grant for each account. Each account can have a maximum of 500 requests that wait for a decision.
- **Crash-safe acquisition into Whisparr:** Velvarr records each attempt before the network call, so a restart never loses or duplicates an add.
- **Jellyfin availability** for each user, and watch links without credentials.
- **Performer follows** across both providers, with a Following view and a Discover rail.
- **Studios:** open Studios from the sidebar or the mobile More menu to browse studios in recent releases.
- **Preferences:** open Preferences from the sidebar, the mobile More menu, or the account menu to edit hidden tags and Discover shelf order while keeping your place.
- **Similar titles** for movies and scenes, and **Often appears with** for performers.
- **Possible duplicate movies:** TPDB movie details compare hashes or cast, year, tags, duration, and poster similarity. Copy a manual report with both TPDB links.
- **Update notice** when a newer GitHub release is available.
- [Optional Discord notifications](configuration.md#discord-notifications) use Settings → Connections → Discord. Save changes without a restart. Checks never post channel messages.
- **Optional:** [Smarter library matching](ai.md), through [TypeSafe](https://typesafe.ai) or an [Ollama](ai.md#ai-matching-with-ollama) decision model.
  AI flags possible matches between requested titles and differently named Jellyfin titles for administrator review.
  It also sorts similar titles on detail pages and suggests up to three real tags for search terms.
  It never marks a title as available.
- **Optional natural-language search** on Browse: a member describes a search in plain words, and an [OpenAI-compatible chat server](ai.md#natural-language-search) that you set up writes a draft of the filters. Velvarr checks each tag, performer, and studio against the providers before it applies a filter, and lists each part that it did not apply.

## Browse date ranges

A year range includes both years. A release-date range includes both dates.
Newest first sends the upper bound to the provider. Oldest first sends the lower bound.
With release-date order, Browse stops after the opposite bound.
Other local filters can still reach the scan limit.

## TPDB performer artwork

Performer pages and search results prefer artwork from the performer's own
`posters[]` array. Velvarr selects the allowed URL with the
largest finite numeric `size` greater than zero. Equal sizes keep the first
array entry, regardless of `order`. Missing, zero, negative, non-finite, and
non-numeric sizes do not qualify.

Title credits first use the canonical parent's largest eligible poster,
then the credit row's largest eligible poster. A usable canonical poster
takes precedence even when the credit row has a larger poster. This keeps
the credit artwork consistent with the linked performer's canonical artwork.

Every candidate must pass the existing artwork URL check. This change does
not permit new hosts or URL variants. Byte size ranks the published candidates,
but it does not prove pixel dimensions or image quality.

If no poster qualifies, performer pages and search results retain the
`image`, `thumbnail`, then `face` fallback. If neither the parent nor the
credit row has an eligible poster, credits retain the canonical parent's
`image`, then the credit row's `image`. The URL check still applies to each
fallback. Credits use a valid canonical parent UUID, or the credit row UUID.
They keep the credited name and one entry per UUID.

## Possible duplicate TPDB movies

The check runs after a TPDB movie detail loads. Playback and request actions do not wait for it.
It checks one page for the first eligible performer and release year, plus up to five distinct file hashes.
It compares at most ten candidate posters. Notes identify failed sources, missing fields, and limits.
This is not a complete catalog scan.

An exact same-type OSHASH or PHASH match qualifies independently of metadata.
Otherwise, both casts must be non-empty and one cast must contain the other.
Both dates must have the same year. At least half of the smaller tag set must match.
Known durations must differ by no more than ten percent of the longer duration.
Poster dHash distance must be at most ten bits out of 64.
Titles and studios can differ, so translated releases can qualify.

Hidden-tag preferences suppress candidates. A complete check without matches shows no notice.
For a possible duplicate, select **Copy report** and submit the text on TPDB yourself.
TPDB links require website sign-in. Velvarr never submits the report, merges records, or hides either record.
