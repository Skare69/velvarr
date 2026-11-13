import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import "./setup.ts";
import {
  buildPrefixIndex,
  looksWindows,
  pathComponents,
  prefixMatches,
  samePathPrefix,
} from "../src/server/pathmap.ts";

// Few, case-colliding components (final sigma included) so prefixes, case
// differences and Windows folding all occur often.
const component = fc.constantFrom("a", "A", "b", "B", "Σ", "σ", "ς", "İ", "i");
const path = fc
  .record({
    drive: fc.boolean(),
    sep: fc.constantFrom("/", "\\"),
    comps: fc.array(component, { maxLength: 4 }),
  })
  .map(({ drive, sep, comps }) => (drive ? "C:" : "") + sep + comps.join(sep));
const entry = fc.record({
  comps: fc.array(component, { maxLength: 3 }),
  fold: fc.boolean(),
});

test("the prefix index returns exactly the entries samePathPrefix accepts, in entry order", () => {
  fc.assert(
    fc.property(
      fc.array(entry, { maxLength: 12 }),
      fc.array(path, { maxLength: 3 }),
      (entries, paths) => {
        const index = buildPrefixIndex(
          entries.map((e, value) => ({ ...e, value })),
        );
        const expected = entries.flatMap((e, value) =>
          paths.some((p) =>
            samePathPrefix(
              e.comps,
              pathComponents(p),
              e.fold || looksWindows(p),
            ),
          )
            ? [value]
            : [],
        );
        assert.deepEqual(prefixMatches(index, paths), expected);
      },
    ),
  );
});
