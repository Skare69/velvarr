// Decision vocabulary for the requests list: the four-state lifecycle, the
// filter and sort vocabulary of GET /api/requests, and the PATCH error
// wording. The server filters, sorts and pages; its acquisition status cases
// mirror lib/status's acquisitionPhase. No React, no component imports.

import type { RequestDecision } from "./contracts";

/** Group order for the requests list; sections render in this sequence. */
export const GROUP_ORDER: readonly RequestDecision[] = [
  "pending",
  "approved",
  "declined",
  "cancelled",
];

export const GROUP_LABEL: Record<RequestDecision, string> = {
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

/** GET /api/requests page size: the default `limit` and its ceiling. */
export const REQUEST_PAGE_SIZE = 50;
export const REQUEST_PAGE_MAX = 200;

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
