// The intent lists' shared decision vocabulary: one lifecycle order for both
// tables and per-endpoint error messages. The order is the render contract
// for requests and removals alike; the key sets are the wire codes the PATCH
// routes emit, so a dropped key would strand a code with no message.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GROUP_LABEL,
  GROUP_ORDER,
  REMOVAL_DECISION_ERRORS,
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
  assert.deepEqual(Object.keys(REMOVAL_DECISION_ERRORS).sort(), [
    "forbidden",
    "invalid_decision",
    "invalid_level",
    "removal_disabled",
    "request_not_found",
    "request_not_pending",
  ]);
  for (const table of [REQUEST_DECISION_ERRORS, REMOVAL_DECISION_ERRORS]) {
    for (const [code, message] of Object.entries(table)) {
      assert.ok(message.length > 0, `message for ${code}`);
    }
  }
});
