import type { Account, RequestRecord } from "./contracts.ts";

/** How many of these requests this account may actually decide right now:
 * elevated roles decide anyone's pending request, an autoApprove grant only
 * its own. Mirrors the server's decision gate and the Requests view's per-row
 * `canApprove`, so the sidebar badge can never promise work the account is not
 * allowed to do. */
export function countPendingApprovals(
  requests: RequestRecord[],
  account: Account,
): number {
  const staff = account.role === "admin" || account.role === "moderator";
  let count = 0;
  for (const request of requests) {
    if (request.decision !== "pending") continue;
    if (staff || (account.autoApprove && request.accountId === account.id))
      count++;
  }
  return count;
}
