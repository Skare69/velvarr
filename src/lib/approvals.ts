import type { Account, RequestRecord, Role } from "./contracts.ts";

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

/** Whether this account may merge or unmerge duplicate TPDB entries:
 * administrators always may, other roles need a mergeDuplicates grant.
 * Mirrors the server's merge gate, so the detail view never offers a merge
 * action the server would refuse — and never hides one it allows. */
export function canMergeDuplicates(account: {
  role: Role;
  mergeDuplicates: boolean;
}): boolean {
  return account.role === "admin" || account.mergeDuplicates === true;
}

/** Fired on `window` whenever a view has just read authoritative request rows
 * (initial load, Refresh, or after a decision), so the sidebar badge can
 * re-read instead of going stale until the next navigation. */
export const REQUESTS_CHANGED = "velvarr:requests-changed";
