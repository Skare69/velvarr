// Requests view as an admin: two pending requests to decide and the
// approved ones below, one of them downloading.
import { HOUR, MOVIES, NOW, SCENES } from "../demo.mjs";

const byTitle = (title) =>
  [...SCENES, ...MOVIES].find((c) => c.detail.title === title);

// The requesters are other accounts than the signed-in admin: on the admin's
// own rows the card shows Cancel instead of Decline.
const MARA = { id: "demo-mara", name: "Mara" };
const JONAS = { id: "demo-jonas", name: "Jonas" };

const acquisition = (state, progress = null) => ({
  state,
  lastError: null,
  updatedAt: NOW - HOUR,
  observationStale: false,
  monitored: true,
  progress,
});

/** One RequestListItem (src/lib/contracts.ts). */
function row(title, who, decision, ageHours, decidedHours, acq = null) {
  const media = byTitle(title).detail.reference;
  return {
    id: `req-${media.id}`,
    accountId: who.id,
    media,
    decision,
    createdAt: NOW - ageHours * HOUR,
    decidedAt: decidedHours === null ? null : NOW - decidedHours * HOUR,
    requestedBy: who.name,
    requestedById: who.id,
    acquisition: acq,
  };
}

const ROWS = [
  row("Blue Hour Above the City", MARA, "pending", 5, null),
  row("The Pink Motel", JONAS, "pending", 10, null),
  row(
    "By the Fireplace",
    MARA,
    "approved",
    15,
    12,
    acquisition("downloading", { percent: 62, timeleft: "00:12:40" }),
  ),
  row("Room Service", JONAS, "approved", 20, 18, acquisition("monitoring")),
  row(
    "After Midnight in Lisbon",
    MARA,
    "approved",
    30,
    28,
    acquisition("imported"),
  ),
  row("Poolside Afternoon", JONAS, "approved", 44, 40, acquisition("imported")),
];

const PHASE_STATE = { processing: "downloading", library: "imported" };

/** GET /api/requests with the view's filters (type, status, sort, limit). */
function listRequests(query) {
  const type = query.get("type") ?? "all";
  const status = query.get("status") ?? "all";
  const limit = Number(query.get("limit") ?? 50);
  const key = (r) =>
    query.get("sort") === "modified"
      ? (r.decidedAt ?? r.createdAt)
      : r.createdAt;
  const rows = ROWS.filter((r) => type === "all" || r.media.kind === type)
    .filter(
      (r) =>
        status === "all" ||
        r.decision === status ||
        (PHASE_STATE[status] !== undefined &&
          r.acquisition?.state === PHASE_STATE[status]),
    )
    .sort((a, b) => key(b) - key(a));
  return {
    requests: rows.slice(0, limit),
    nextCursor: rows.length > limit ? "demo-next" : null,
    pendingApprovals: ROWS.filter((r) => r.decision === "pending").length,
  };
}

export default {
  width: 1800,
  height: 1226,
  // Main column = 1400 - 200 px sidebar = 1200 CSS px, x1.5 = 1800 px.
  viewport: { width: 1400, height: 900 },
  scale: 1.5,
  mobile: false,
  url: "/?view=requests",
  clip: "main",
  api({ method, path, query }) {
    if (method === "GET" && path === "/api/requests")
      return listRequests(query);
    return undefined;
  },
  async prepare(page) {
    // The clip shows the main column without the fixed top bar above it.
    await page.addStyleTag({
      content:
        ".app-topbar { display: none !important; } .app-main { padding-top: var(--page-gutter) !important; }",
    });
    await page.getByText("Downloading — 62% (00:12:40 left)").waitFor();
    // Titles and posters come from the per-card catalog reads.
    await page
      .locator(".request-title")
      .nth(ROWS.length - 1)
      .waitFor();
  },
};
