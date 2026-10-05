// The unified status ladder, pinned directly: one rule for cards, the detail
// page and discovery tiles. These cases are exactly the precedence questions
// the two hand-rolled ladders answered differently.

import assert from "node:assert/strict";
import { test } from "node:test";
import { acquisitionPhase, statusOf } from "../src/lib/status.ts";

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

test("unmonitored beats downloading (the card rule, now everywhere)", () => {
  // The card reads "Paused" for an unmonitored download — Whisparr will
  // never deliver it — so the ladder agrees; fe54360c pinned the opposite
  // here, which let the requests filter list that row under Processing.
  assert.equal(statusOf({ acquisition: acq("downloading", false) }), "paused");
});

test("acquisitionPhase: one precedence for pill, line, ladder and filters", () => {
  assert.equal(
    acquisitionPhase({ state: "imported", monitored: false }),
    "library",
  );
  assert.equal(
    acquisitionPhase({ state: "imported", monitored: true }),
    "library",
  );
  assert.equal(
    acquisitionPhase({ state: "downloading", monitored: false }),
    "paused",
  );
  assert.equal(
    acquisitionPhase({ state: "failed", monitored: false }),
    "paused",
  );
  assert.equal(
    acquisitionPhase({ state: "downloading", monitored: true }),
    "processing",
  );
  assert.equal(
    acquisitionPhase({ state: "failed", monitored: true }),
    "failed",
  );
  assert.equal(
    acquisitionPhase({ state: "monitoring", monitored: true }),
    null,
  );
  assert.equal(acquisitionPhase({ state: "blocked", monitored: true }), null);
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
  assert.equal(
    statusOf({
      acquisition: acq("monitoring"),
      myRequest: { decision: "cancelled" },
    }),
    "declined",
  );
});

test("an imported title keeps decided rows decided", () => {
  // Imported + declined/cancelled: done acquiring, the decision still speaks.
  assert.equal(
    statusOf({
      acquisition: acq("imported", false),
      myRequest: { decision: "declined" },
    }),
    "declined",
  );
  assert.equal(
    statusOf({
      acquisition: acq("imported", true),
      myRequest: { decision: "cancelled" },
    }),
    "declined",
  );
  // Monitored and not yet imported with a pending request: still being
  // acquired, so approved — the decision has not lapsed into a badge yet.
  assert.equal(
    statusOf({
      acquisition: acq("monitoring"),
      myRequest: { decision: "pending" },
    }),
    "approved",
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
