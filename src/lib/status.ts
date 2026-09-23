// The one status ladder: playable beats downloading beats unmonitored, and
// an imported-but-unscanned title is a decision fact, never "Paused in
// Whisparr". Every surface that badges a title — cards, detail page,
// discovery tiles — consumes this; the two hand-rolled ladders it replaced
// disagreed on precedence, which is why this moved here: React-free, so
// node:test can pin it directly.

export type CardStatusKind =
  "requested" | "approved" | "available" | "declined" | "processing" | "paused";

export type StatusInput = {
  availability?: { outcome: string } | null;
  acquisition?: { state: string; monitored?: boolean | null } | null;
  myRequest?: { decision: string } | null;
};

export function statusOf(s: StatusInput): CardStatusKind | null {
  if (s.availability?.outcome === "available") return "available";
  const acq = s.acquisition;
  if (acq?.state === "downloading") return "processing";
  const d = s.myRequest?.decision;
  // An imported-but-unscanned title falls to its decision fact — it is done
  // acquiring, so "Paused in Whisparr" would be a lie.
  if (acq?.monitored === false && acq.state !== "imported") return "paused";
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
