// The Requests view's decision gate, pinned directly: elevated roles decide
// anyone's pending row, an autoApprove grant only the account's own. A flipped
// comparison or a broken staff short-circuit changes a boolean here instead of
// offering a button the server refuses.

import assert from "node:assert/strict";
import { test } from "node:test";
import { canApproveRequest } from "../src/lib/approvals.ts";
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

// The predicate reads only decision and accountId; the rest of the record is
// fixture noise for this unit.
const request = (decision: string, accountId: string): RequestRecord =>
  ({ decision, accountId }) as unknown as RequestRecord;

test("staff may decide any pending row", () => {
  for (const role of ["admin", "moderator"] as const) {
    assert.equal(
      canApproveRequest(request("pending", "them"), account({ role })),
      true,
    );
    assert.equal(
      canApproveRequest(request("pending", "me"), account({ role })),
      true,
    );
  }
});

test("an autoApprove grant reaches only the account's own pending rows", () => {
  const granted = account({ autoApprove: true });
  assert.equal(canApproveRequest(request("pending", "me"), granted), true);
  assert.equal(canApproveRequest(request("pending", "them"), granted), false);
});

test("a plain requester may decide nothing, not even its own row", () => {
  const plain = account({});
  assert.equal(canApproveRequest(request("pending", "me"), plain), false);
  assert.equal(canApproveRequest(request("pending", "them"), plain), false);
});

test("decided rows are never decidable, for staff and granted accounts alike", () => {
  for (const decision of ["approved", "declined", "cancelled"]) {
    assert.equal(
      canApproveRequest(request(decision, "me"), account({ role: "admin" })),
      false,
    );
    assert.equal(
      canApproveRequest(
        request(decision, "me"),
        account({ autoApprove: true }),
      ),
      false,
    );
  }
});
