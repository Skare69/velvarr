// The one status ladder: playable beats everything; an item Whisparr has
// stopped monitoring reads Paused for as long as it is still acquiring
// (Whisparr will never deliver it); an imported-but-unscanned title is a
// decision fact, never "Paused in Whisparr". Every surface that badges a
// title — request cards, the detail page, discovery tiles — and the
// requests status filter consume this; the hand-rolled ladders it replaced
// disagreed on precedence, which is why this moved here: React-free, so
// node:test can pin it directly.

import type { AcquisitionState } from "./contracts";

export type CardStatusKind =
  "requested" | "approved" | "available" | "declined" | "processing" | "paused";

export type StatusInput = {
  availability?: { outcome: string } | null;
  acquisition?: { state: string; monitored?: boolean | null } | null;
  myRequest?: { decision: string } | null;
};

/** The one acquisition precedence, shared by the pill, the acquisition
 * line, the ladder below and the requests status filter: imported is
 * library, then unmonitored beats every still-acquiring state, then
 * downloading, then failed. */
export type AcquisitionPhase = "paused" | "processing" | "failed" | "library";

export function acquisitionPhase(a: {
  state: string;
  monitored?: boolean | null;
}): AcquisitionPhase | null {
  if (a.state === "imported") return "library";
  if (a.monitored === false) return "paused";
  if (a.state === "downloading") return "processing";
  // failed_permanent shows the same failed face everywhere; only the worker's scheduling differs (terminal, no recheck).
  if (a.state === "failed" || a.state === "failed_permanent") return "failed";
  return null;
}

export function statusOf(s: StatusInput): CardStatusKind | null {
  if (s.availability?.outcome === "available") return "available";
  const acq = s.acquisition;
  const phase = acq ? acquisitionPhase(acq) : null;
  if (phase === "processing") return "processing";
  if (phase === "paused") return "paused";
  const d = s.myRequest?.decision;
  // An imported-but-unscanned title falls to its decision fact — it is done
  // acquiring, so "Paused in Whisparr" would be a lie; acquisitionPhase has
  // already routed imported away from "paused" above.
  if (acq) {
    if (acq.state === "imported") {
      if (d === "pending") return "requested";
      if (d === "declined" || d === "cancelled") return "declined";
      return "approved";
    }
    return d === "declined" || d === "cancelled" ? "declined" : "approved";
  }
  if (d === "approved") return "approved";
  if (d === "pending") return "requested";
  if (d === "declined" || d === "cancelled") return "declined";
  return null;
}

/** The acquisition line under a card's facts; the request cards and the
 * catalog detail share it. */
export function acquisitionText(a: {
  state: AcquisitionState;
  lastError: string | null;
  monitored?: boolean | null;
  progress?: { percent: number | null; timeleft: string | null } | null;
}): string {
  if (acquisitionPhase(a) === "paused")
    return "Paused — Whisparr is not monitoring this item";
  // A non-null lastError is a real failed check: surface it even for states
  // that are still in flight.
  const lastCheck = a.lastError ? ` — last check: ${a.lastError}` : "";
  switch (a.state) {
    case "unsent":
      return `Queued — not submitted yet${lastCheck}`;
    case "submitting":
      return "Queued — being submitted";
    case "monitoring":
      return lastCheck
        ? `Watching for a release${lastCheck}`
        : "Watching for a release (this is not a failure)";
    case "downloading": {
      if (typeof a.progress?.percent !== "number")
        return `Downloading${lastCheck}`;
      const left = a.progress.timeleft;
      return left
        ? `Downloading — ${a.progress.percent}% (${left} left)${lastCheck}`
        : `Downloading — ${a.progress.percent}%${lastCheck}`;
    }
    case "imported":
      return "Imported by Whisparr";
    case "uncertain":
      return a.lastError
        ? `Being reconciled — last check: ${a.lastError}`
        : "Being reconciled — the last check was inconclusive";
    case "failed":
      return a.lastError ? `Failed — ${a.lastError}` : "Failed";
    case "failed_permanent":
      return a.lastError
        ? `Failed — ${a.lastError} (will not be retried)`
        : "Failed (will not be retried)";
    case "blocked":
      return "Blocked — delivery is turned off";
  }
}
