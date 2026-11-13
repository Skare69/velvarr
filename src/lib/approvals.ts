import type { Account, RequestRecord } from "./contracts.ts";

/** Whether this account may decide this request right now: elevated roles
 * decide anyone's pending request, an autoApprove grant only its own. Mirrors
 * the server's decision gate, so the Requests view never offers a decision
 * the server would refuse. */
export function canApproveRequest(
  request: RequestRecord,
  account: Account,
): boolean {
  if (request.decision !== "pending") return false;
  const staff = account.role === "admin" || account.role === "moderator";
  return staff || (account.autoApprove && request.accountId === account.id);
}

/** Fired on `window` whenever a view has just read authoritative request rows
 * (initial load, Refresh, or after a decision), so the sidebar badge can
 * re-read instead of going stale until the next navigation. */
export const REQUESTS_CHANGED = "velvarr:requests-changed";
