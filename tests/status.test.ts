// The unified status ladder, pinned directly: one rule for cards, the detail
// page and discovery tiles. These cases are exactly the precedence questions
// the two hand-rolled ladders answered differently.

import assert from "node:assert/strict";
import { test } from "node:test";
import { statusOf } from "../src/lib/status.ts";

const avail = { outcome: "available" };
const acq = (state: string, monitored = true) => ({ state, monitored });

test("playable beats everything, everywhere", () => {
  assert.equal(
    statusOf({
      availability: avail,
      acquisition: acq("downloading", false),
      myRequest: { decision: "pending" },
    }),
    "available",
  );
});

test("downloading beats unmonitored (the card rule, now everywhere)", () => {
  assert.equal(
    statusOf({ acquisition: acq("downloading", false) }),
    "processing",
  );
});

test("imported-but-unscanned is never Paused: it reads as its decision", () => {
  assert.equal(
    statusOf({
      acquisition: acq("imported", false),
      myRequest: { decision: "approved" },
    }),
    "approved",
  );
  assert.equal(
    statusOf({
      acquisition: acq("imported", false),
      myRequest: { decision: "pending" },
    }),
    "requested",
  );
});

test("unmonitored, not yet imported, reads Paused", () => {
  assert.equal(statusOf({ acquisition: acq("monitoring", false) }), "paused");
});

test("an acquisition makes the row approved unless the decision says otherwise", () => {
  assert.equal(statusOf({ acquisition: acq("monitoring") }), "approved");
  assert.equal(
    statusOf({
      acquisition: acq("monitoring"),
      myRequest: { decision: "declined" },
    }),
    "declined",
  );
});

test("decision-only rows: pending, approved, declined; nothing means no badge", () => {
  assert.equal(statusOf({ myRequest: { decision: "pending" } }), "requested");
  assert.equal(statusOf({ myRequest: { decision: "approved" } }), "approved");
  assert.equal(statusOf({ myRequest: { decision: "declined" } }), "declined");
  assert.equal(statusOf({ myRequest: { decision: "cancelled" } }), "declined");
  assert.equal(statusOf({}), null);
  assert.equal(statusOf({ availability: { outcome: "unavailable" } }), null);
});
