// The filter-name cache: browse URLs carry provider-native ids; chips,
// headings and rails need the names those ids stand for. Details, search
// picks and facet tiles are where names are known — each surface seeds the
// exact shape it owns, and an id never seeded labels AS an id (#12345678…),
// never a fake name.

const filterNames = new Map<string, string>();

const key = (provider: string, kind: string, id: string): string =>
  `${provider}:${kind}:${id}`;

/** One known name for one provider reference. */
export function seedName(
  ref: { provider: string; kind: string; id: string },
  name: string,
): void {
  filterNames.set(key(ref.provider, ref.kind, ref.id), name);
}

/** A performer search pick: one row, one side, one name. */
export function seedPerformerPick(
  side: "tpdb" | "stashdb",
  performer: { reference: { id: string }; title: string },
): void {
  seedName(
    { provider: side, kind: "performer", id: performer.reference.id },
    performer.title,
  );
}

/** Everything one catalog detail names: its studio, its tags, its credits. */
export function seedDetail(
  d: {
    reference: { provider: string };
    studio?: { name?: string } | null;
    tags: { id: string; name: string }[];
    credits: {
      reference: { provider: string; kind: string; id: string };
      name: string;
    }[];
  },
  studioRef: { provider: string; id: string } | null,
  tagBrowse: boolean,
): void {
  if (studioRef)
    seedName(
      { provider: studioRef.provider, kind: "studio", id: studioRef.id },
      d.studio?.name ?? studioRef.id,
    );
  if (tagBrowse)
    for (const t of d.tags)
      seedName(
        { provider: d.reference.provider, kind: "tag", id: t.id },
        t.name,
      );
  for (const c of d.credits) seedName(c.reference, c.name);
}

/** A discover facet tile plus its resolved cross-provider counterpart. */
export function seedFacetTile(item: {
  provider: string;
  facet: string;
  id: string;
  name: string;
  linked?: { provider: string; id: string };
}): void {
  seedName(
    { provider: item.provider, kind: item.facet, id: item.id },
    item.name,
  );
  if (item.linked)
    seedName(
      { provider: item.linked.provider, kind: item.facet, id: item.linked.id },
      item.name,
    );
}

/** The label for an id: the seeded name, or the id shown AS an id. */
export function filterName(provider: string, kind: string, id: string): string {
  return filterNames.get(key(provider, kind, id)) ?? `#${id.slice(0, 8)}…`;
}
