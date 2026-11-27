# Boolean filter controls

## Behavior

Browse exposes the same tag AND/OR model as enhanced search.

- Each Must have term is a tag or an OR group.
- All terms match with AND.
- Any member of an OR group can match its term.
- The URL keeps the existing `include` JSON array.
- A singleton stays an object. An OR group stays an array of at least two tag objects.
- Tags keep their names and provider ids.

The Must have picker shows an **Add next tag** choice with **AND** and **OR** buttons.
AND is the default. It adds a new term.
OR adds the next tag to the last term, unless the user selects another term with **Add OR**.
With no terms, OR is disabled. The user first adds a tag.
Each selected term offers **Add OR**, including a singleton.
The picker names the selected OR target near the input.
The next tag consumes that target. The picker then returns to AND.
The AND button cancels an OR target without a URL change.

A valid OR target identifies the whole term, not only its list index.
If the term disappears or changes through navigation, the picker must not extend a different term.
A removal clears the target. A disabled or capped picker offers no active add action.
The existing 25-member cap counts every group member.
The existing duplicate rule still applies.

The selected list shows AND between separate terms and OR within each group.
A search-created group stays editable through the same controls.
The user can extend any group or remove a whole term.
A reload keeps the query structure because the URL holds the filters.

## Boundaries and errors

Exclusions and hidden tags stay flat lists. They show no AND/OR controls.
Their existing exclusion rules do not change.
Performer all/any controls and studio rules do not change.
A failed provider search keeps its existing named error.
The controls do not bypass server validation or provider limits.
A group action must not change a term before the user selects the next tag.

## Acceptance checks

1. Add A and B with AND. Confirm `include=[A,B]`.
2. Add A, select OR, and add B. Confirm `include=[[A,B]]`.
3. Add C with AND. Confirm `include=[[A,B],C]`.
4. Select Add OR for C and add D. Confirm `include=[[A,B],[C,D]]`.
5. Open a search-created group. Extend it and preserve every existing provider id.
6. Select OR, cancel with AND, and add a tag. Confirm a new term.
7. Change the query while OR is armed. Confirm no different term receives the next tag.
8. Confirm the serialized filter reaches `/api/browse` unchanged.
9. Confirm equivalent manual and enhanced-search filters use the same include structure.
10. Check the 25-member cap and duplicate prevention.
11. Confirm exclusions and hidden tags offer no group actions.
12. Run the existing Browse and prose-map tests and the new browser cases.
13. Check keyboard access and 44px touch targets at phone width.
14. Save desktop and phone browser proof. Run a blind visual check.
15. Pass format, type, unit/API test, and production build gates.

## Non-goals

- No new API field, route, storage layout, or query grammar.
- No OR between independent filter types.
- No arbitrary recursive Boolean tree.
- No new exclusion operator, studio operator, or performer behavior.
- No enhanced-search model, prompt, or language change.
- No read-only fallback for a query shape that enhanced search cannot create.

## Phone layout invariant

At a configured 375px viewport, the document and the drawer stay within 375px.
The `type=scene&perPage=24` case includes two OR groups, provider ids, and populated results.
The case also adds a long tag name through the keyboard.
The header close button, footer close button, and Add OR buttons remain fully visible.
The new controls keep 44px touch targets.

The Sort control shares its wrapper across Browse, Requests, and Library.
Its nested flex row must shrink without a change to the caption width.
The drawer must not conceal overflow from that row.

The regression ran against the production build before the CSS fix.
Its width assertion failed with `Expected: <= 375` and `Received: 417`.
