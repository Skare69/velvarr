// The sidebar badge's decision gate, pinned directly: elevated roles decide
// anyone's pending rows, an autoApprove grant only the account's own. Mirrors
// countPendingApprovals's two audiences so a flipped comparison or a broken
// staff short-circuit changes a number here instead of a wrong badge.

import assert from "node:assert/strict";
import { test } from "node:test";
import { countPendingApprovals } from "../src/lib/approvals.ts";
import type { Account, RequestRecord } from "../src/lib/contracts.ts";

const account = (over: Partial<Account>): Account =>
  ({
    id: "me",
    name: "Me",
    role: "requester",
    enabled: true,
    libraryIds: [],
    isOwner: false,
    autoApprove: false,
    joinedAt: 0,
    ...over,
  }) as Account;

// The function reads only decision and accountId; the rest of the record is
// fixture noise for this unit.
const request = (decision: string, accountId: string): RequestRecord =>
  ({ decision, accountId }) as unknown as RequestRecord;

test("the badge counts only rows this account may decide", () => {
  const rows = [
    request("pending", "me"),
    request("pending", "them"),
    request("pending", "someone-else"),
  ];

  // Auto-approve is a grant for one's own rows only: one of three.
  assert.equal(countPendingApprovals(rows, account({ autoApprove: true })), 1);

  // Elevated roles decide every pending row, grant or not: all three.
  assert.equal(countPendingApprovals(rows, account({ role: "moderator" })), 3);
  assert.equal(countPendingApprovals(rows, account({ role: "admin" })), 3);

  // A plain requester with no grant may decide none of them.
  assert.equal(countPendingApprovals(rows, account({})), 0);
});

test("decided rows never count, for staff and granted accounts alike", () => {
  const rows = [
    request("pending", "me"),
    request("approved", "me"),
    request("declined", "them"),
  ];
  assert.equal(countPendingApprovals(rows, account({ role: "admin" })), 1);
  assert.equal(countPendingApprovals(rows, account({ autoApprove: true })), 1);
});
