import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCareerRange } from "../src/lib/person.ts";

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
