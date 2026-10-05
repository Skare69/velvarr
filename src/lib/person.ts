// Person-bio formatting shared by the performer UI and pinned by tests: a
// career range states only the years the provider published, never a claim
// about whether the person is still active.

/** "2009–2015"; an absent end stays open ("2009–") instead of claiming
 * "present"; a lone end year still renders ("–2015"). No years, no row. */
export function formatCareerRange(
  startYear?: number,
  endYear?: number,
): string | undefined {
  if (startYear === undefined && endYear === undefined) return undefined;
  if (endYear === undefined) return `${startYear}–`;
  if (startYear === undefined) return `–${endYear}`;
  return `${startYear}–${endYear}`;
}
