// The requests' shared decision vocabulary: one lifecycle order and
// per-endpoint error messages. The order is the render contract for
// requests; the key set is the wire codes the PATCH routes emit, so a
// dropped key would strand a code with no message.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GROUP_LABEL,
  GROUP_ORDER,
  REQUEST_DECISION_ERRORS,
} from "../src/lib/decisions.ts";

test("intent groups render in the shared lifecycle order, each with a label", () => {
  assert.deepEqual(
    [...GROUP_ORDER],
    ["pending", "approved", "declined", "cancelled"],
  );
  for (const decision of GROUP_ORDER) {
    assert.ok(GROUP_LABEL[decision].length > 0, `label for ${decision}`);
  }
});

test("every PATCH error code has a message in its endpoint's table", () => {
  assert.deepEqual(Object.keys(REQUEST_DECISION_ERRORS).sort(), [
    "forbidden",
    "request_not_cancellable",
    "request_not_found",
    "request_not_pending",
  ]);
  for (const [code, message] of Object.entries(REQUEST_DECISION_ERRORS)) {
    assert.ok(message.length > 0, `message for ${code}`);
  }
});
