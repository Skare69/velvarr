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

/**
 * Whole years since an ISO birth date (YYYY-MM-DD) on `today`, or undefined
 * when the provider's accuracy cannot settle it: a year-only date is off by
 * one for most of the year, and a month-accurate date is ambiguous during
 * the birth month itself. The provider publishes no death date here, so the
 * age is the age the person would be today.
 */
export function ageOn(
  iso: string,
  accuracy: "day" | "month" | "year" | undefined,
  today: Date,
): number | undefined {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d || accuracy === "year") return undefined;
  const ty = today.getFullYear();
  const tm = today.getMonth() + 1;
  const td = today.getDate();
  if (accuracy === "month" && tm === m) return undefined;
  const before = tm < m || (tm === m && td < d);
  const age = ty - y - (before ? 1 : 0);
  return age >= 0 && age < 130 ? age : undefined;
}
