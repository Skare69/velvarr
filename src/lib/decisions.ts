// Decision vocabulary for the intent lists (requests): the
// shared four-state lifecycle and the per-endpoint PATCH error wording.
// Pure data — no React, no component imports — so either side can read it.

import type { RequestDecision, RequestListItem } from "./contracts";

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

/* Requests-view filters (Seerr-style): media type, status, sort. Statuses
 * name exactly the facts a row already shows — its decision chip or the
 * acquisition pill/line on the same card — so a filtered list never claims
 * a state the row does not display. */

export const REQUEST_TYPES = ["all", "movie", "scene"] as const;
export type RequestTypeFilter = (typeof REQUEST_TYPES)[number];

export const REQUEST_STATUSES = [
  "all",
  "pending",
  "approved",
  "declined",
  "cancelled",
  "processing",
  "failed",
  "library",
  "paused",
] as const;
export type RequestStatusFilter = (typeof REQUEST_STATUSES)[number];

export const REQUEST_SORTS = ["recent", "modified"] as const;
export type RequestSort = (typeof REQUEST_SORTS)[number];

export const REQUEST_STATUS_LABELS: Record<RequestStatusFilter, string> = {
  all: "All statuses",
  pending: "Pending",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Cancelled",
  processing: "Processing",
  failed: "Failed",
  library: "In library",
  paused: "Paused",
};

export function filterRequestRows(
  rows: readonly RequestListItem[],
  type: RequestTypeFilter,
  status: RequestStatusFilter,
  sort: RequestSort,
): RequestListItem[] {
  const matching = rows.filter((r) => {
    if (type !== "all" && r.media.kind !== type) return false;
    switch (status) {
      case "all":
        return true;
      case "pending":
      case "approved":
      case "declined":
      case "cancelled":
        return r.decision === status;
      case "processing":
        return r.acquisition?.state === "downloading";
      case "failed":
        return r.acquisition?.state === "failed";
      case "library":
        return r.acquisition?.state === "imported";
      case "paused":
        return (
          r.acquisition != null &&
          r.acquisition.monitored === false &&
          r.acquisition.state !== "imported"
        );
    }
  });
  // "recent" sorts by creation; "modified" by the last time anything about
  // the row moved — creation, the decision, or the attached acquisition.
  const at = (r: RequestListItem) =>
    Math.max(r.createdAt, r.decidedAt ?? 0, r.acquisition?.updatedAt ?? 0);
  return matching.toSorted(
    sort === "recent"
      ? (a, b) => b.createdAt - a.createdAt
      : (a, b) => at(b) - at(a),
  );
}
