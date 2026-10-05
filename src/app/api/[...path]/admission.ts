import type {
  Account,
  ExternalUser,
  IntegrationConfig,
} from "../../../lib/contracts.ts";
import {
  getConfig,
  getSession,
  revokeSession,
} from "../../../server/storage.ts";
import { readSessionToken } from "../../../server/security.ts";
import { AppError } from "../../../server/http.ts";
import { validateUser } from "../../../server/jellyfin.ts";

export interface AuthContext {
  config: IntegrationConfig;
  account: Account;
  token: string;
  rawSessionToken: string;
}

// --- response + parsing helpers ---

export function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export async function requireSession(request: Request): Promise<AuthContext> {
  const rawSessionToken = readSessionToken(request);
  if (!rawSessionToken)
    throw new AppError(401, "unauthenticated", "Sign in required.");
  const session = getSession(rawSessionToken);
  if (!session) throw new AppError(401, "unauthenticated", "Sign in required.");
  const config = getConfig();
  if (!config)
    throw new AppError(409, "not_initialized", "Setup has not been completed.");
  let user: ExternalUser;
  try {
    user = await validateUser(config, session.jellyfinToken);
  } catch (err) {
    // Proven upstream rejection invalidates the session; transient failures block without deleting state.
    if (err instanceof AppError && (err.status === 401 || err.status === 403)) {
      revokeSession(rawSessionToken);
      throw new AppError(401, "session_revoked", "Session is no longer valid.");
    }
    throw err;
  }
  if (user.id !== session.account.id) {
    revokeSession(rawSessionToken);
    throw new AppError(401, "session_revoked", "Session is no longer valid.");
  }
  if (user.isDisabled) {
    revokeSession(rawSessionToken);
    throw new AppError(403, "account_disabled", "This account is disabled.");
  }
  if (!user.enableRemoteAccess) {
    throw new AppError(
      403,
      "remote_denied",
      "Remote access is disabled for this account.",
    );
  }
  return {
    config,
    account: session.account,
    token: session.jellyfinToken,
    rawSessionToken,
  };
}

export async function requireAdmin(request: Request): Promise<AuthContext> {
  const ctx = await requireSession(request);
  if (ctx.account.role !== "admin")
    throw new AppError(403, "forbidden", "Administrator access required.");
  return ctx;
}

// The route declaration contract: admission is part of the route type, so a
// new route cannot ship without declaring none|session|admin. `segments`
// exclude the `/api` prefix; a segment starting with `:` captures one
// path parameter. Matching is exact (method + count + literal/:param), so no
// entry can shadow another.
export type RouteDef = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  segments: string[];
  auth: "open" | "session" | "admin";
  run: (
    ctx: AuthContext,
    request: Request,
    params: Record<string, string>,
  ) => Promise<Response>;
};
