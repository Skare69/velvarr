# Features

- **Catalogs:** movies (TPDB), scenes (TPDB and StashDB), performers, and studios, with the filters and sort orders that each provider supports.
- **Artwork:** StashDB uses the servable image with the largest valid pixel area. If no servable image has valid dimensions, it uses the first servable image.
- **Browse:** one grid for TPDB movies and StashDB scenes, with search, tag include and exclude ("or" groups included), up to five performers with an all-or-any choice, up to five studios, a year range, and date filters. A filter an entry cannot ride on one source says so in a note beside the grid. The URL holds every filter.
- **Search, Studios, and Genres** across both providers. Velvarr never merges results across providers. Cross-provider identity comes only from links that the providers publish.
- **Requests** with administrator or moderator approval, and an optional auto-approve grant for each account. Each account can have a maximum of 500 requests that wait for a decision.
- **Crash-safe acquisition into Whisparr:** Velvarr records each attempt before the network call, so a restart never loses or duplicates an add.
- **Jellyfin availability** for each user, and watch links without credentials.
- **Performer follows** across both providers, with a Following view and a Discover rail.
- **Preferences:** hidden tags and Discover shelf order for each account.
- **Similar titles** for movies and scenes, and **Often appears with** for performers.
- **Update notice** when a newer GitHub release is available.
- **Optional:** Discord notifications, and AI-assisted title matching through [TypeSafe](https://typesafe.ai) or an [Ollama](ai.md#ai-matching-with-ollama) decision model. AI only flags a near match for administrator review. It never marks a title as available.
- **Optional natural-language search** on Browse: a member describes a search in plain words, and an [OpenAI-compatible chat server](ai.md#natural-language-search) that you set up writes a draft of the filters. Velvarr checks each tag, performer, and studio against the providers before it applies a filter, and lists each part that it did not apply.

## Browse date ranges

A year range includes both years. A release-date range includes both dates.
Newest first sends the upper bound to the provider. Oldest first sends the lower bound.
With release-date order, Browse stops after the opposite bound.
Other local filters can still reach the scan limit.

## TPDB performer artwork

Performer pages, search results, and title credits prefer artwork from the
performer row's `posters[]` array. Velvarr selects the allowed URL with the
largest finite numeric `size` greater than zero. Equal sizes keep the first
array entry, regardless of `order`. Missing, zero, negative, non-finite, and
non-numeric sizes do not qualify.

Every candidate must pass the existing artwork URL check. This change does
not permit new hosts or URL variants. Byte size ranks the published candidates,
but it does not prove pixel dimensions or image quality.

If no poster qualifies, performer pages and search results retain the
`image`, `thumbnail`, then `face` fallback. Credits retain the canonical
parent's `image`, then the credit row's `image`. The URL check still applies
to each fallback. Credits use a valid canonical parent UUID, or the credit
row UUID. They keep the credited name and one entry per UUID.
