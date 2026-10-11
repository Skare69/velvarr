// The unified status ladder, pinned directly: one rule for cards, the detail
// page and discovery tiles. These cases are exactly the precedence questions
// the two hand-rolled ladders answered differently.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acquisitionPhase,
  acquisitionText,
  statusOf,
} from "../src/lib/status.ts";

const avail = { outcome: "available" };
const acq = (state: string, monitored: boolean | null = true) => ({
  state,
  monitored,
});

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

test("monitored-null absence row is not Paused: it reads as its decision", () => {
  // A proven absence clears whisparr_monitored to null; that is not the same
  // as recorded-unmonitored, so the paused phase must not trigger. A live
  // acquisition still drives the badge (approved), even while the decision
  // is pending — the pinned precedence in the test below.
  assert.equal(
    acquisitionPhase({ state: "monitoring", monitored: null }),
    null,
  );
  assert.equal(statusOf({ acquisition: acq("monitoring", null) }), "approved");
  assert.equal(
    statusOf({
      acquisition: acq("monitoring", null),
      myRequest: { decision: "pending" },
    }),
    "approved",
  );
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

test("a monitored downloading acquisition reads Processing", () => {
  // Badge honesty: still being acquired, and Whisparr is watching — the
  // card must not claim Approved while bytes are in flight.
  assert.equal(statusOf({ acquisition: acq("downloading") }), "processing");
});

test("acquisitionText: one line per state, on cards and catalog detail", () => {
  // The paused line wins before the switch: Whisparr will never deliver an
  // unmonitored item, whatever its state says.
  assert.equal(
    acquisitionText({
      state: "downloading",
      lastError: null,
      monitored: false,
    }),
    "Paused — Whisparr is not monitoring this item",
  );
  assert.equal(
    acquisitionText({ state: "unsent", lastError: null }),
    "Queued — not submitted yet",
  );
  assert.equal(
    acquisitionText({ state: "submitting", lastError: null }),
    "Queued — being submitted",
  );
  assert.equal(
    acquisitionText({ state: "monitoring", lastError: null }),
    "Watching for a release (this is not a failure)",
  );
  assert.equal(
    acquisitionText({
      state: "monitoring",
      lastError: "HTTP 502 from Whisparr",
    }),
    "Watching for a release — last check: HTTP 502 from Whisparr",
  );
  assert.equal(
    acquisitionText({
      state: "unsent",
      lastError: "whisparr delivery is disabled or unconfigured",
    }),
    "Queued — not submitted yet — last check: whisparr delivery is disabled or unconfigured",
  );
  assert.equal(
    acquisitionText({ state: "imported", lastError: null }),
    "Imported — in your library",
  );
  assert.equal(
    acquisitionText({
      state: "uncertain",
      lastError: "HTTP 502 from Whisparr",
    }),
    "Being reconciled — last check: HTTP 502 from Whisparr",
  );
  assert.equal(
    acquisitionText({ state: "uncertain", lastError: null }),
    "Being reconciled — the last check was inconclusive",
  );
  assert.equal(
    acquisitionText({ state: "failed", lastError: "HTTP 403 from Whisparr" }),
    "Failed — HTTP 403 from Whisparr",
  );
  assert.equal(acquisitionText({ state: "failed", lastError: null }), "Failed");
  assert.equal(
    acquisitionText({ state: "blocked", lastError: null }),
    "Blocked — delivery is turned off",
  );
});

test("acquisitionText: the downloading line carries only real progress", () => {
  assert.equal(
    acquisitionText({ state: "downloading", lastError: null }),
    "Downloading",
  );
  assert.equal(
    acquisitionText({
      state: "downloading",
      lastError: null,
      progress: { percent: null, timeleft: "00:12:34" },
    }),
    "Downloading",
  );
  assert.equal(
    acquisitionText({
      state: "downloading",
      lastError: null,
      progress: { percent: 42, timeleft: null },
    }),
    "Downloading — 42%",
  );
  assert.equal(
    acquisitionText({
      state: "downloading",
      lastError: null,
      progress: { percent: 42, timeleft: "00:12:34" },
    }),
    "Downloading — 42% (00:12:34 left)",
  );
  assert.equal(
    acquisitionText({
      state: "downloading",
      lastError: "HTTP 502 from Whisparr",
      progress: { percent: 45, timeleft: null },
    }),
    "Downloading — 45% — last check: HTTP 502 from Whisparr",
  );
  assert.equal(
    acquisitionText({
      state: "downloading",
      lastError: "HTTP 502 from Whisparr",
      progress: { percent: 45, timeleft: "00:12:34" },
    }),
    "Downloading — 45% (00:12:34 left) — last check: HTTP 502 from Whisparr",
  );
});
