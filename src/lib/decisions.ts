// Decision vocabulary for the intent lists (requests and removals): the
// shared four-state lifecycle and the per-endpoint PATCH error wording.
// Pure data — no React, no component imports — so either side can read it.

import type { RemovalDecision, RequestDecision } from "./contracts";

/** Both intent kinds share the same four-state lifecycle. */
export type DecisionKind = RequestDecision | RemovalDecision;

/** Group order for every intent list; sections render in this sequence. */
export const GROUP_ORDER: readonly DecisionKind[] = [
  "pending",
  "approved",
  "declined",
  "cancelled",
];

export const GROUP_LABEL: Record<DecisionKind, string> = {
  pending: "Pending",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Cancelled",
};

/** Error codes from PATCH /api/requests/:id, mapped faithfully per row. */
export const REQUEST_DECISION_ERRORS: Record<string, string> = {
  forbidden: "You do not have permission to change this request.",
  request_not_found:
    "This request no longer exists — it may have already been removed. Refresh to update the list.",
  request_not_pending:
    "This request is no longer pending — it was already decided. Refresh to see the current state.",
  request_not_cancellable:
    "This request can no longer be cancelled. Refresh to see the current state.",
};

/** Error codes from PATCH /api/removals/:id, mapped faithfully per row. The
 * code sets overlap with the requests table, but every message names its own
 * endpoint's subject — two tables, deliberately not flattened into one. */
export const REMOVAL_DECISION_ERRORS: Record<string, string> = {
  forbidden: "You do not have permission to decide this removal request.",
  request_not_found:
    "This removal request no longer exists — refresh to update the list.",
  request_not_pending:
    "This removal request was already decided — refresh to see the current state.",
  invalid_level:
    "Choose a removal level first — the level is always the approver's explicit choice.",
  removal_disabled:
    "Removal is turned off by the operator, so this request cannot be decided right now.",
  invalid_decision: "That decision is not valid here.",
};
