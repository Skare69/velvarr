import assert from "node:assert/strict";
import { test } from "node:test";

import { withFixture } from "./fixture.ts";

for (const [label, failure] of [
  ["Error message", new Error("Synthetic fixture failure")],
  [
    "stack trace text",
    new Error(
      "Synthetic fixture failure\n    at syntheticHandler (/synthetic/fixture.ts:1:1)",
    ),
  ],
  ["non-Error value", "Synthetic thrown value"],
] as const) {
  test(`fixture handler failure hides ${label}`, async () => {
    await withFixture(
      () => {
        throw failure;
      },
      async ({ origin }) => {
        const response = await fetch(origin, {
          signal: AbortSignal.timeout(5_000),
        });
        assert.equal(response.status, 500);
        assert.equal(response.headers.get("content-type"), "application/json");
        assert.deepEqual(await response.json(), {
          fixtureError: "Fixture handler failed",
        });
      },
    );
  });
}
