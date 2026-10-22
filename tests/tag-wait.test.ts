// The tag picker's commit/wait lifecycle (src/lib/tag-wait.ts): the debounce
// owns `committed`, a free-text pick arms `awaitingFree` for the promotion
// effect (VELV-46). VELV-50: a pick against a settled answer must arm
// nothing — a settled answer is final, so nothing would ever consume the
// wait, and `release` would then keep the old query (and a failed search's
// alert) alive after the input cleared.

import assert from "node:assert/strict";
import { test } from "node:test";

import { initTagWait, reduceTagWait } from "../src/lib/tag-wait.ts";

test("a settled free-text pick arms no wait; clearing the input releases the query", () => {
  // The debounced search for "ab" has settled (loading false): its answer
  // is final, so a free-text pick on it can never be promoted.
  let w = reduceTagWait(initTagWait(), { type: "commit", term: "ab" });
  w = reduceTagWait(w, { type: "pickFreeText", term: "ab", loading: false });
  assert.equal(w.awaitingFree, null);
  // The input clears: with no wait armed, the debounce releases the query.
  w = reduceTagWait(w, { type: "release" });
  assert.equal(w.committed, null);
});

test("a free-text pick on an unsettled answer arms the wait and keeps the query alive", () => {
  let w = reduceTagWait(initTagWait(), {
    type: "pickFreeText",
    term: "cd",
    loading: true,
  });
  assert.equal(w.awaitingFree, "cd");
  assert.equal(w.committed, "cd");
  // The input clears mid-flight: the answer must still reach the hook.
  w = reduceTagWait(w, { type: "release" });
  assert.equal(w.committed, "cd");
  // The answer settles: the promotion effect consumes the wait.
  w = reduceTagWait(w, { type: "consumed" });
  assert.equal(w.awaitingFree, null);
});

test("a free-text pick inside the debounce window commits the term at once", () => {
  const w = reduceTagWait(initTagWait(), {
    type: "pickFreeText",
    term: "ef",
    loading: false,
  });
  assert.equal(w.committed, "ef");
  assert.equal(w.awaitingFree, "ef");
});

test("no-op actions return the same state", () => {
  const w = initTagWait();
  assert.equal(reduceTagWait(w, { type: "release" }), w);
  assert.equal(reduceTagWait(w, { type: "consumed" }), w);
  // A commit of the already-committed term is the debounce's Object.is
  // no-op: useReducer skips the re-render, as setCommitted(t) did.
  const settled = reduceTagWait(w, { type: "commit", term: "ab" });
  assert.equal(reduceTagWait(settled, { type: "commit", term: "ab" }), settled);
});
