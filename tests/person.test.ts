import assert from "node:assert/strict";
import { test } from "node:test";
import { ageOn, formatCareerRange } from "../src/lib/person.ts";

// The career row is an honesty surface: an unknown end year must never read
// as "present", and a lone end year must not be dropped.

test("a closed range renders both years", () => {
  assert.equal(formatCareerRange(2009, 2015), "2009–2015");
});

test("an open end renders without claiming the person is still active", () => {
  assert.equal(formatCareerRange(2009), "2009–");
  assert.equal(formatCareerRange(2009, undefined), "2009–");
});

test("a lone end year renders with the start side open", () => {
  assert.equal(formatCareerRange(undefined, 2015), "–2015");
});

test("no published years, no career row", () => {
  assert.equal(formatCareerRange(), undefined);
  assert.equal(formatCareerRange(undefined, undefined), undefined);
});

// Age is shown only when the provider's accuracy settles it.

test("a day-accurate birth date gives the age, counting the birthday", () => {
  const today = new Date(2026, 10, 13); // 13 November 2026
  assert.equal(ageOn("1994-09-21", "day", today), 32);
  assert.equal(ageOn("1988-11-18", "day", today), 37);
  assert.equal(ageOn("1988-11-13", "day", today), 38);
});

test("a year-only date never claims an age, a month-only one not in its month", () => {
  const today = new Date(2026, 10, 13);
  assert.equal(ageOn("1994-01-01", "year", today), undefined);
  assert.equal(ageOn("1988-11-01", "month", today), undefined);
  assert.equal(ageOn("1988-03-01", "month", today), 38);
});
