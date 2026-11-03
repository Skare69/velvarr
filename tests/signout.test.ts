// The sign-out failure decision (src/lib/signout.ts), pinned without a
// React harness. The card bug: a failed POST /api/logout (a network error,
// a CSRF 403, a 5xx) cleared the tab's session view anyway, so the login
// screen hid a still-valid session cookie. The contract: only a 200 (no
// throw) or an explicit 401 "no session" answer may clear the view; every
// other failure keeps the tab signed in.

import assert from "node:assert/strict";
import { test } from "node:test";
import { signOutKeepsSession } from "../src/lib/signout.ts";

test("a network failure (status 0) leaves the session valid", () => {
  assert.equal(signOutKeepsSession({ status: 0 }), true);
});

test("a CSRF 403 leaves the session valid", () => {
  assert.equal(signOutKeepsSession({ status: 403 }), true);
});

test("a 5xx leaves the session valid", () => {
  assert.equal(signOutKeepsSession({ status: 503 }), true);
});

test("an unexpected error shape is treated as a live session", () => {
  assert.equal(signOutKeepsSession(undefined), true);
  assert.equal(signOutKeepsSession("boom"), true);
});

test("an explicit no-session 401 may clear the view", () => {
  assert.equal(signOutKeepsSession({ status: 401 }), false);
});
