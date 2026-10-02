// Decision vocabulary for the intent lists (requests): the
// shared four-state lifecycle and the per-endpoint PATCH error wording.
// Pure data — no React, no component imports — so either side can read it.

import type { RequestDecision } from "./contracts";

/** Both intent kinds share the same four-state lifecycle. */
export type DecisionKind = RequestDecision;

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
