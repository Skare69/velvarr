// API intake: Next entry points + dispatch over the folded domain tables.
// Every route lives in a domain module under routes/ and declares
// { method, segments, auth, run } — admission stays part of the route type,
// the origin-CSRF gate runs here before matching, and matching is exact
// (method + segment count + literal/:param), so no entry can shadow another.
import type { AuthContext, RateLane, RouteDef } from "./admission.ts";
import { chargeRateBudget, requireAdmin, requireSession } from "./admission.ts";
import { guardMutation } from "../../../server/security.ts";
import { AppError } from "../../../server/http.ts";
import { json } from "./admission.ts";
import { routes as authRoutes } from "./routes/auth.ts";
import { routes as requestRoutes } from "./routes/requests.ts";
import { routes as followRoutes } from "./routes/follows.ts";
import { routes as catalogRoutes } from "./routes/catalog.ts";
import { routes as browseRoutes } from "./routes/browse.ts";
import { routes as libraryRoutes } from "./routes/library.ts";
import { routes as adminRoutes } from "./routes/admin.ts";
import { routes as discoverRoutes } from "./routes/discover.ts";

const ROUTES: RouteDef[] = [
  ...authRoutes,
  ...requestRoutes,
  ...followRoutes,
  ...catalogRoutes,
  ...browseRoutes,
  ...libraryRoutes,
  ...adminRoutes,
  ...discoverRoutes,
];

function match(method: string, segments: string[]): RouteDef | undefined {
  return ROUTES.find(
    (r) =>
      r.method === method &&
      r.segments.length === segments.length &&
      r.segments.every((pat, i) => pat.startsWith(":") || pat === segments[i]),
  );
}

function paramsOf(def: RouteDef, segments: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  def.segments.forEach((pat, i) => {
    if (pat.startsWith(":")) params[pat.slice(1)] = segments[i]!;
  });
  return params;
}

// The preload lane is for RequestableCard preloads, and only movie and
// scene tiles preload. The catalog detail route also serves performer and
// studio detail, which no card ever fires — and one performer detail can
// fan out to a counterpart search plus up to ten reads — so those kinds
// keep the audited dispatch budget (RATE_BURST / 30 per minute) instead of
// the preload lane's page-sized 600 / 120. Unknown kinds fall toward
// dispatch, the tighter lane, before the handler rejects them.
function laneFor(def: RouteDef, segments: string[]): RateLane {
  if (def.lane !== "preload") return def.lane ?? "dispatch";
  const kind = paramsOf(def, segments).kind;
  return kind === "movie" || kind === "scene" ? "preload" : "dispatch";
}

// The only wire 401s: dead Velvarr sessions. The client (shared.tsx api())
// signs out on any 401, so an upstream credential rejection (requireSuccess,
// Jellyfin setup/validate) must not travel as 401 — it would sign every user
// out. Those leave as 502 with code and message unchanged.
const SESSION_401_CODES: Record<string, true> = {
  unauthenticated: true,
  session_revoked: true,
};

function errorResponse(
  err: unknown,
  method: string,
  pathname: string,
): Response {
  if (err instanceof AppError) {
    const status =
      err.status === 401 && !SESSION_401_CODES[err.code] ? 502 : err.status;
    return json({ error: { code: err.code, message: err.message } }, status);
  }
  // Unexpected faults (TypeError, SQLite constraint, decrypt bug) must leave a
  // trace: method + pathname only — never the query string, which can carry
  // secrets — plus the error's own name/message/stack.
  console.error(`${method} ${pathname}: unexpected route failure`, err);
  return json(
    { error: { code: "internal", message: "Internal server error." } },
    500,
  );
}

// Segments come from the request URL, not `context.params`: Next strips the
// static `/api` prefix from a catch-all's params, so trusting params made every
// route 404 in a real server while direct-handler tests passed.
async function dispatch(request: Request, method: string): Promise<Response> {
  try {
    const segments = new URL(request.url).pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          // A malformed percent-escape (e.g. /api/catalog/%E0%A4%A) is the
          // caller's mistake: a 400, not an unlogged 500.
          throw new AppError(400, "invalid_path", "Invalid request path.");
        }
      });
    // The one origin-CSRF gate: runs before matching and before admission on
    // every mutation, keeping the first-failure precedence it had when each
    // handler called it, and a future mutating route cannot ship without it.
    if (method !== "GET") guardMutation(request);
    const def = match(method, segments.slice(1));
    if (!def) throw new AppError(404, "not_found", "Unknown route.");
    if (def.auth === "open") {
      return await def.run(undefined as unknown as AuthContext, request, {});
    }
    const ctx: AuthContext =
      def.auth === "admin"
        ? await requireAdmin(request)
        : await requireSession(request);
    // The per-account rate budget is charged here, at the one dispatch point
    // admission already funnels through, synchronously before the handler:
    // a parallel burst cannot all pass on a stale token count. Every session
    // and admin route charges; per-tile page-load routes charge their own
    // lane (def.lane) so a page of card preloads cannot drain the dispatch
    // budget, and artwork routes are exempt at dispatch — the catalog
    // artwork proxy charges an upstream cache miss in its handler instead,
    // so cached tiles stay free while provider fetches stay bounded.
    if (!def.exemptFromBudget) {
      chargeRateBudget(ctx.account.id, laneFor(def, segments.slice(1)));
    }
    return await def.run(ctx, request, paramsOf(def, segments.slice(1)));
  } catch (err) {
    return errorResponse(err, method, new URL(request.url).pathname);
  }
}

export async function GET(request: Request): Promise<Response> {
  return dispatch(request, "GET");
}

export async function POST(request: Request): Promise<Response> {
  return dispatch(request, "POST");
}

export async function PATCH(request: Request): Promise<Response> {
  return dispatch(request, "PATCH");
}

export async function DELETE(request: Request): Promise<Response> {
  return dispatch(request, "DELETE");
}
