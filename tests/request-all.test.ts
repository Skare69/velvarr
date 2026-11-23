// Browse "Request all": which displayed titles one press files, and how the
// bounded, stop-on-limit runner tallies the outcome the confirm dialog reports.

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  planRequestAll,
  REQUEST_ALL_CAP,
  requestAllKey,
  runRequestAll,
} from "../src/lib/request-all.ts";
import {
  isDeliverableMedia,
  type CatalogKind,
  type CatalogProvider,
  type CatalogReference,
  type MediaReference,
} from "../src/lib/contracts.ts";

const item = (provider: CatalogProvider, kind: CatalogKind, id: string) => ({
  reference: { provider, kind, id },
});
const movie = (id: string): MediaReference => ({
  provider: "tpdb",
  kind: "movie",
  id,
});

class CodedError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

test("the cap takes the first 20 eligible titles in display order", () => {
  const items = Array.from({ length: 30 }, (_, i) =>
    i % 2 === 0
      ? item("tpdb", "movie", `m${i}`)
      : item("stashdb", "scene", `s${i}`),
  );
  const plan = planRequestAll(items, new Set());
  assert.equal(REQUEST_ALL_CAP, 20);
  assert.equal(plan.batch.length, 20);
  assert.equal(plan.over, 10);
  assert.equal(plan.undeliverable, 0);
  assert.deepEqual(
    plan.batch.map((r) => r.id),
    items.slice(0, 20).map((it) => it.reference.id),
  );
});

test("undeliverable, already-settled and duplicate titles never enter the batch", () => {
  const items = [
    item("tpdb", "scene", "tpdb-scene"),
    item("tpdb", "movie", "ABC"),
    item("stashdb", "scene", "done-one"),
    item("tpdb", "movie", "abc"),
    item("stashdb", "movie", "stash-movie"),
    item("stashdb", "scene", "fresh"),
    item("tpdb", "performer", "someone"),
  ];
  const done = new Set([
    requestAllKey({ provider: "stashdb", kind: "scene", id: "DONE-ONE" }),
  ]);
  const plan = planRequestAll(items, done, 1);
  assert.deepEqual(plan.batch, [
    { provider: "tpdb", kind: "movie", id: "ABC" },
  ]);
  // "done-one" and the case-folded duplicate "abc" are skipped, not deferred.
  assert.equal(plan.over, 1);
  assert.equal(plan.undeliverable, 3);
});

test("the runner never has more than `concurrency` posts in flight", async () => {
  const batch = Array.from({ length: 10 }, (_, i) => movie(`m${i}`));
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const result = await runRequestAll(
    batch,
    async () => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return {};
    },
    3,
  );
  assert.equal(maxInFlight, 3);
  assert.equal(calls, batch.length);
  assert.equal(result.requested, batch.length);
  assert.equal(result.notSent, 0);
});

test("the runner tallies each outcome and settles only requested and existing titles", async () => {
  const batch = [
    movie("ok"),
    movie("auto"),
    movie("exists"),
    movie("broken"),
    movie("thrown"),
  ];
  const result = await runRequestAll(batch, async (ref) => {
    await Promise.resolve();
    if (ref.id === "auto") return { autoApproved: true };
    if (ref.id === "exists")
      throw new CodedError("request_exists", "already requested");
    if (ref.id === "broken") throw new CodedError("upstream_down", "nope");
    if (ref.id === "thrown") throw new Error("no code");
    return {};
  });
  assert.equal(result.requested, 2);
  assert.equal(result.autoApproved, 1);
  assert.equal(result.existing, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.notSent, 0);
  assert.equal(result.stopped, null);
  assert.deepEqual([...result.settled].sort(), [
    "tpdb:movie:auto",
    "tpdb:movie:exists",
    "tpdb:movie:ok",
  ]);
});

test("a request_limit error stops new posts and reports the rest as not sent", async () => {
  const batch = [movie("a"), movie("b"), movie("c"), movie("d"), movie("e")];
  const posted: string[] = [];
  const result = await runRequestAll(
    batch,
    async (ref) => {
      posted.push(ref.id);
      await Promise.resolve();
      if (ref.id === "b")
        throw new CodedError("request_limit", "Pending limit reached");
      return {};
    },
    1,
  );
  assert.deepEqual(posted, ["a", "b"]);
  assert.equal(result.requested, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.notSent, 3);
  assert.deepEqual(result.stopped, {
    code: "request_limit",
    message: "Pending limit reached",
  });
  assert.deepEqual(result.settled, ["tpdb:movie:a"]);
});

test("property: the plan accounts for every item and respects the cap", () => {
  const ref: fc.Arbitrary<CatalogReference> = fc.record({
    provider: fc.constantFrom<CatalogProvider>("tpdb", "stashdb"),
    kind: fc.constantFrom<CatalogKind>("movie", "scene"),
    id: fc.constantFrom("a", "A", "b", "c", "D", "d", "e"),
  });
  fc.assert(
    fc.property(
      fc.array(ref, { maxLength: 60 }),
      fc.array(ref, { maxLength: 10 }),
      fc.integer({ min: 0, max: 40 }),
      (refs, doneRefs, cap) => {
        const done = new Set(doneRefs.map(requestAllKey));
        const plan = planRequestAll(
          refs.map((reference) => ({ reference })),
          done,
          cap,
        );
        // Reference count of deliverable refs skipped as settled or repeated.
        const seen = new Set<string>();
        let skipped = 0;
        for (const r of refs) {
          if (!isDeliverableMedia(r)) continue;
          const key = requestAllKey(r);
          if (done.has(key) || seen.has(key)) skipped++;
          seen.add(key);
        }
        assert.ok(plan.batch.length <= cap);
        assert.equal(
          plan.batch.length + plan.over + plan.undeliverable + skipped,
          refs.length,
        );
        assert.ok(plan.batch.every(isDeliverableMedia));
      },
    ),
    { seed: 42, numRuns: 100 },
  );
});
