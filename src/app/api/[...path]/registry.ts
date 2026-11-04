// The folded dispatch surface, owned once: route.ts matches requests over it
// and tests/api.test.ts asserts the no-shadow property over the same defs.
// The fold is lazy and memoized so it observes a domain array that grows at
// module scope after imports — tests push a plain-Error route into
// catalogRoutes before any test runs, and folding on first use sees it,
// exactly like the inline fold in route.ts that this replaces.
import type { RouteDef } from "./admission.ts";
import { routes as authRoutes } from "./routes/auth.ts";
import { routes as requestRoutes } from "./routes/requests.ts";
import { routes as followRoutes } from "./routes/follows.ts";
import { routes as catalogRoutes } from "./routes/catalog.ts";
import { routes as browseRoutes } from "./routes/browse.ts";
import { routes as libraryRoutes } from "./routes/library.ts";
import { routes as adminRoutes } from "./routes/admin.ts";
import { routes as discoverRoutes } from "./routes/discover.ts";

let folded: RouteDef[] | undefined;

/** All route defs, folded once on first use. */
export function routeTable(): RouteDef[] {
  folded ??= [
    ...authRoutes,
    ...requestRoutes,
    ...followRoutes,
    ...catalogRoutes,
    ...browseRoutes,
    ...libraryRoutes,
    ...adminRoutes,
    ...discoverRoutes,
  ];
  return folded;
}
