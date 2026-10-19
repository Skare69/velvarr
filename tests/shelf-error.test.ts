// The one shelf-failure wire policy: an AppError speaks verbatim (its code
// and message are written for the client), everything else degrades to the
// generic internal error — raw exception text never rides the wire. Browse
// streams, discover rails and the tag picker all render this shape per
// provider, so a plain adapter fault must read the same everywhere.

import assert from "node:assert/strict";
import { test } from "node:test";

import { AppError, shelfError, sourceError } from "../src/server/http.ts";

test("an AppError keeps its code and message", () => {
  const err = new AppError(502, "upstream_unavailable", "TPDB unreachable.");
  assert.deepEqual(shelfError(err), {
    code: "upstream_unavailable",
    message: "TPDB unreachable.",
  });
  assert.deepEqual(sourceError("stashdb", err), {
    provider: "stashdb",
    code: "upstream_unavailable",
    message: "TPDB unreachable.",
  });
});

test("a plain adapter fault degrades to the generic internal error", () => {
  // The parsing-bug class from the field: a TypeError's message (URLs,
  // property chains, stack details) must never reach a signed-in client.
  const err = new TypeError(
    "Cannot read properties of undefined (reading 'data')",
  );
  assert.deepEqual(shelfError(err), {
    code: "internal",
    message: "Internal server error.",
  });
  assert.deepEqual(sourceError("tpdb", err), {
    provider: "tpdb",
    code: "internal",
    message: "Internal server error.",
  });
});

test("a thrown non-Error value degrades the same way", () => {
  assert.deepEqual(shelfError("connection reset"), {
    code: "internal",
    message: "Internal server error.",
  });
  assert.deepEqual(sourceError("stashdb", undefined), {
    provider: "stashdb",
    code: "internal",
    message: "Internal server error.",
  });
});
