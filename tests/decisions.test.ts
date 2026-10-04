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
  REQUEST_SORTS,
  REQUEST_STATUSES,
  REQUEST_STATUS_LABELS,
  REQUEST_TYPES,
  filterRequestRows,
} from "../src/lib/decisions.ts";
import type { RequestDecision, RequestListItem } from "../src/lib/contracts.ts";

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

// Requests-view filters. Statuses must name exactly what a row's card shows
// (its decision chip, or the acquisition pill/line) — an option that selects
// rows by a fact the list never displays would be a lie.

function row(fields: {
  kind?: "movie" | "scene";
  decision?: RequestDecision;
  createdAt?: number;
  decidedAt?: number | null;
  acquisition?: RequestListItem["acquisition"];
}): RequestListItem {
  return {
    id: `r${(rowSeq += 1)}`,
    accountId: "u1",
    media: {
      provider: (fields.kind ?? "movie") === "movie" ? "tpdb" : "stashdb",
      kind: fields.kind ?? "movie",
      id: "m1",
    },
    decision: fields.decision ?? "pending",
    createdAt: fields.createdAt ?? 1000,
    decidedAt: fields.decidedAt ?? null,
    acquisition: fields.acquisition ?? null,
  };
}
let rowSeq = 0;

test("filter vocabularies expose a label for every option", () => {
  assert.deepEqual([...REQUEST_TYPES], ["all", "movie", "scene"]);
  assert.deepEqual([...REQUEST_SORTS], ["recent", "modified"]);
  assert.deepEqual(Object.keys(REQUEST_STATUS_LABELS), [...REQUEST_STATUSES]);
  for (const label of Object.values(REQUEST_STATUS_LABELS)) {
    assert.ok(label.length > 0);
  }
});

test("type filter keeps only the selected media kind", () => {
  const rows = [
    row({ kind: "movie" }),
    row({ kind: "scene" }),
    row({ kind: "movie" }),
  ];
  assert.equal(filterRequestRows(rows, "movie", "all", "recent").length, 2);
  assert.equal(filterRequestRows(rows, "scene", "all", "recent").length, 1);
  assert.equal(filterRequestRows(rows, "all", "all", "recent").length, 3);
});

test("decision statuses select rows by their decision chip", () => {
  const rows = [
    row({ decision: "pending" }),
    row({ decision: "approved" }),
    row({ decision: "declined" }),
    row({ decision: "cancelled" }),
  ];
  for (const d of ["pending", "approved", "declined", "cancelled"] as const) {
    const kept = filterRequestRows(rows, "all", d, "recent");
    assert.deepEqual(
      kept.map((r) => r.decision),
      [d],
    );
  }
});

test("acquisition statuses follow the facts the card displays", () => {
  const downloading = row({
    decision: "approved",
    acquisition: {
      state: "downloading",
      lastError: null,
      updatedAt: 2000,
      observationStale: false,
      monitored: true,
      progress: null,
    },
  });
  const failed = row({
    decision: "approved",
    acquisition: {
      state: "failed",
      lastError: "boom",
      updatedAt: 2000,
      observationStale: false,
      monitored: true,
      progress: null,
    },
  });
  const imported = row({
    decision: "approved",
    acquisition: {
      state: "imported",
      lastError: null,
      updatedAt: 2000,
      observationStale: false,
      monitored: true,
      progress: null,
    },
  });
  // Unmonitored, still acquiring: the card's "Paused" pill.
  const paused = row({
    decision: "approved",
    acquisition: {
      state: "monitoring",
      lastError: null,
      updatedAt: 2000,
      observationStale: false,
      monitored: false,
      progress: null,
    },
  });
  // Imported-but-unmonitored is a done title, never "Paused" (status.ts rule).
  const importedUnmonitored = row({
    decision: "approved",
    acquisition: {
      state: "imported",
      lastError: null,
      updatedAt: 2000,
      observationStale: false,
      monitored: false,
      progress: null,
    },
  });
  const rows = [
    downloading,
    failed,
    imported,
    paused,
    importedUnmonitored,
    row({ decision: "pending" }),
  ];
  const only = (status: Parameters<typeof filterRequestRows>[2]) =>
    filterRequestRows(rows, "all", status, "recent").map((r) => r.id);
  assert.deepEqual(only("processing"), [downloading.id]);
  assert.deepEqual(only("failed"), [failed.id]);
  assert.deepEqual(only("library"), [imported.id, importedUnmonitored.id]);
  assert.deepEqual(only("paused"), [paused.id]);
});

test("sort: recent orders by creation, modified by last activity", () => {
  const rows = [
    row({ createdAt: 1000 }),
    row({
      createdAt: 500,
      decision: "approved",
      decidedAt: 9000,
    }),
    row({ createdAt: 3000 }),
  ];
  const ids = (r: RequestListItem[]) => r.map((x) => x.createdAt);
  assert.deepEqual(
    ids(filterRequestRows(rows, "all", "all", "recent")),
    [3000, 1000, 500],
  );
  // The decided row moved last, so "modified" lifts it to the top.
  assert.deepEqual(
    ids(filterRequestRows(rows, "all", "all", "modified")),
    [500, 3000, 1000],
  );
});
