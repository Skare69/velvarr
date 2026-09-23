// API intake: Next entry points + dispatch over the folded domain tables.
// Every route lives in a domain module under routes/ and declares
// { method, segments, auth, run } — admission stays part of the route type,
// the origin-CSRF gate runs here before matching, and matching is exact
// (method + segment count + literal/:param), so no entry can shadow another.
import type { AuthContext, RouteDef } from "./admission.ts";
import { requireAdmin, requireSession } from "./admission.ts";
import { guardMutation } from "../../../server/security.ts";
import { AppError } from "../../../server/http.ts";
import { json } from "./admission.ts";
import { routes as authRoutes } from "./routes/auth.ts";
import { routes as requestRoutes } from "./routes/requests.ts";
import { routes as followRoutes } from "./routes/follows.ts";
import { routes as catalogRoutes } from "./routes/catalog.ts";
import { routes as browseRoutes } from "./routes/browse.ts";
import { routes as libraryRoutes } from "./routes/library.ts";
import { routes as removalRoutes } from "./routes/removals.ts";
import { routes as adminRoutes } from "./routes/admin.ts";
import { routes as discoverRoutes } from "./routes/discover.ts";

const ROUTES: RouteDef[] = [
  ...authRoutes,
  ...requestRoutes,
  ...followRoutes,
  ...catalogRoutes,
  ...browseRoutes,
  ...libraryRoutes,
  ...removalRoutes,
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

function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return json(
      { error: { code: err.code, message: err.message } },
      err.status,
    );
  }
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
      .map((segment) => decodeURIComponent(segment));
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
    return await def.run(ctx, request, paramsOf(def, segments.slice(1)));
  } catch (err) {
    return errorResponse(err);
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
