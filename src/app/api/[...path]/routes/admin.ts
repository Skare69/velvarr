import {
  readJson,
  fieldUrl,
  fieldBool,
  fieldRole,
  fieldIds,
  optionalText,
  requireId,
  optionalBool,
} from "../parse.ts";
import { type AuthContext, json } from "../admission.ts";
import type {
  AdminAccount,
  IntegrationConfig,
  WhisparrDelivery,
  WhisparrPathMapping,
  ProviderCheck,
  CredentialProvider,
} from "../../../../lib/contracts.ts";
import {
  isJudgmentProvider,
  isOllamaModel,
} from "../../../../lib/contracts.ts";
import {
  countRequestsByAccount,
  getAccount,
  importAccounts,
  listAccounts,
  saveConfig,
  updateAccount,
} from "../../../../server/storage.ts";
import { AppError, validateBaseUrl } from "../../../../server/http.ts";
import {
  getServer,
  getUserImage,
  listLibraries,
  listUsers,
  getJellyfinStatus,
} from "../../../../server/jellyfin.ts";
import { privateImageResponse } from "./library.ts";
import {
  credentialFingerprint,
  getProviderStatus,
  rejectedKeyClearAllowed,
  storedProviderCredential,
} from "../../../../server/providers.ts";
import {
  judgmentConfiguration,
  checkJudgmentConnection,
} from "../../../../server/judgment.ts";
import { getWhisparrStatus } from "../../../../server/whisparr.ts";

export function integrationsShape(config: IntegrationConfig) {
  return {
    jellyfin: {
      url: config.jellyfin.url,
      externalUrl: config.jellyfin.externalUrl,
      serverId: config.jellyfin.serverId,
      libraryIds: config.jellyfin.libraryIds,
      apiKeyConfigured: config.jellyfin.apiKey.length > 0,
    },
    whisparr: config.whisparr
      ? {
          url: config.whisparr.url,
          apiKeyConfigured: config.whisparr.apiKey.length > 0,
          delivery: config.whisparr.delivery ?? null,
          pathMappings: config.whisparr.pathMappings ?? [],
        }
      : null,
    judgment: judgmentConfiguration(config.providers),
    providers: {
      tpdb: providerShape(config.providers?.tpdbApiToken, "TPDB_API_TOKEN"),
      stashdb: providerShape(
        config.providers?.stashdbApiKey,
        "STASHDB_API_KEY",
      ),
      typesafe: providerShape(
        config.providers?.typesafeApiKey,
        "TYPESAFE_API_KEY",
      ),
    },
  };
}

export function providerShape(
  stored: string | undefined,
  envName: string,
): { configured: boolean; source: "stored" | "environment" } {
  if (typeof stored === "string" && stored !== "") {
    return { configured: true, source: "stored" };
  }
  const env = process.env[envName];
  return {
    configured: typeof env === "string" && env !== "",
    source: "environment",
  };
}

export async function adminUsers(ctx: AuthContext): Promise<Response> {
  const [views, users] = await Promise.all([
    listLibraries(ctx.config, ctx.token),
    listUsers(ctx.config),
  ]);
  const configured = new Set(ctx.config.jellyfin.libraryIds);
  const avatarTags = new Map(
    users.filter((u) => u.imageTag).map((u) => [u.id, u.imageTag as string]),
  );
  const counts = countRequestsByAccount();
  return json({
    accounts: listAccounts().map((account): AdminAccount => {
      const tag = avatarTags.get(account.id);
      return {
        ...account,
        requestCount: counts.get(account.id) ?? 0,
        ...(tag ? { avatarTag: tag } : {}),
      };
    }),
    libraries: views.filter((library) => configured.has(library.id)),
  });
}

/** One account's Jellyfin avatar bytes: admin rows ask by id, every account
 *  asks for its own through /api/me/avatar. No upstream avatar is a 404.
 *  Never browser-cached: /api/me/avatar is one URL for every account. */
export async function userAvatar(
  ctx: AuthContext,
  id: string,
): Promise<Response> {
  return privateImageResponse(await getUserImage(ctx.config, requireId(id)));
}

export async function adminImport(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  await readJson(request);
  const imported = importAccounts(await listUsers(ctx.config));
  return json({ accounts: imported });
}

export async function adminUpdateUser(
  request: Request,
  ctx: AuthContext,
  id: string,
): Promise<Response> {
  const body = await readJson(request);
  const target = getAccount(requireId(id));
  if (!target) throw new AppError(404, "not_found", "Account not found.");
  const enabled = fieldBool(body, "enabled");
  const role = fieldRole(body, "role");
  const libraryIds = fieldIds(body, "libraryIds");
  const autoApprove = optionalBool(body, "autoApprove");
  const configured = new Set(ctx.config.jellyfin.libraryIds);
  if (libraryIds.some((libraryId) => !configured.has(libraryId))) {
    throw new AppError(400, "invalid_field", "Unknown library selected.");
  }
  if (target.isOwner && (!enabled || role !== "admin")) {
    throw new AppError(
      403,
      "forbidden",
      "The owner account cannot be disabled or demoted.",
    );
  }
  const account = updateAccount(target.id, {
    enabled,
    role,
    libraryIds,
    ...(autoApprove !== undefined ? { autoApprove } : {}),
  });
  return json({ account });
}

/** Provider credentials: omitted key = unchanged, "" = clear (falls back to
 * the environment). Verify happens via /api/admin/providers. */
export function nextProviderCredentials(
  existing: IntegrationConfig["providers"],
  body: Record<string, unknown>,
): IntegrationConfig["providers"] {
  const tpdbApiToken = optionalText(body, "tpdbApiToken", 1024);
  const stashdbApiKey = optionalText(body, "stashdbApiKey", 512);
  const typesafeApiKey = optionalText(body, "typesafeApiKey", 512);
  const judgmentProvider = optionalText(body, "judgmentProvider", 16)?.trim();
  const ollamaUrl = optionalText(body, "ollamaUrl", 2048)?.trim();
  const ollamaModel = optionalText(body, "ollamaModel", 128)?.trim();
  if (
    judgmentProvider !== undefined &&
    judgmentProvider !== "" &&
    !isJudgmentProvider(judgmentProvider)
  ) {
    throw new AppError(
      400,
      "invalid_field",
      "Judgment provider must be typesafe, ollama, or none.",
    );
  }
  if (ollamaModel && !isOllamaModel(ollamaModel)) {
    throw new AppError(400, "invalid_field", "Invalid Ollama model name.");
  }
  if (
    tpdbApiToken === undefined &&
    stashdbApiKey === undefined &&
    typesafeApiKey === undefined &&
    judgmentProvider === undefined &&
    ollamaUrl === undefined &&
    ollamaModel === undefined
  ) {
    return existing;
  }
  const providers: NonNullable<IntegrationConfig["providers"]> = {
    judgmentProvider:
      judgmentProvider === undefined
        ? existing?.judgmentProvider
        : judgmentProvider === ""
          ? undefined
          : judgmentProvider,
    ollamaUrl:
      ollamaUrl === undefined
        ? existing?.ollamaUrl
        : ollamaUrl === ""
          ? undefined
          : validateBaseUrl(ollamaUrl),
    ollamaModel:
      ollamaModel === undefined
        ? existing?.ollamaModel
        : ollamaModel === ""
          ? undefined
          : ollamaModel,
    tpdbApiToken:
      tpdbApiToken === undefined
        ? existing?.tpdbApiToken
        : tpdbApiToken === ""
          ? undefined
          : tpdbApiToken.trim(),
    stashdbApiKey:
      stashdbApiKey === undefined
        ? existing?.stashdbApiKey
        : stashdbApiKey === ""
          ? undefined
          : stashdbApiKey.trim(),
    typesafeApiKey:
      typesafeApiKey === undefined
        ? existing?.typesafeApiKey
        : typesafeApiKey === ""
          ? undefined
          : typesafeApiKey.trim(),
  };
  if (
    providers.tpdbApiToken === undefined &&
    providers.stashdbApiKey === undefined &&
    providers.typesafeApiKey === undefined &&
    providers.judgmentProvider === undefined &&
    providers.ollamaUrl === undefined &&
    providers.ollamaModel === undefined
  ) {
    return undefined;
  }
  return providers;
}

/** The stored key follows its URL only within one origin: a cross-origin
 * move must present the key again, and the check runs before any upstream
 * call so the stored secret never reaches the new host. Shared by the save
 * paths and the draft connection tests, so the two can never drift. Both
 * URLs are validateBaseUrl outputs, so they always parse. */
function savedKeyForUrl(input: {
  url: string;
  saved: { url: string; apiKey: string } | undefined;
  supplied: string | undefined;
  messages: { missing: string; moved: string };
}): string {
  if (input.supplied !== undefined && input.supplied !== "")
    return input.supplied;
  if (
    input.saved !== undefined &&
    new URL(input.url).origin === new URL(input.saved.url).origin
  )
    return input.saved.apiKey;
  throw new AppError(
    400,
    "invalid_field",
    input.saved === undefined ? input.messages.missing : input.messages.moved,
  );
}

/** The upstream half of a Jellyfin connection change, shared by the save path
 * and the draft test: the endpoint must answer for the stored server identity
 * (public /System/Info/Public, no key needed) and the key must enumerate
 * users like the administrator key. */
async function checkJellyfinDraft(
  draft: IntegrationConfig["jellyfin"],
): Promise<void> {
  const server = await getServer(draft.url);
  if (server.id !== draft.serverId) {
    throw new AppError(
      400,
      "server_mismatch",
      "Jellyfin server identity cannot change, only its address.",
    );
  }
  await listUsers({ jellyfin: draft });
}

/** Jellyfin connection patch: address and key may change, server identity
 * may not. Authorization for this change is the admin session itself:
 * requireAdmin re-validates the caller upstream on every request (identity,
 * disabled, remote access) and guardMutation rejects foreign origins. No
 * password re-auth: it would re-authenticate under the shared DeviceId,
 * invalidating the caller's own Jellyfin token and logging the admin out. */
async function nextJellyfin(
  current: IntegrationConfig["jellyfin"],
  body: Record<string, unknown>,
): Promise<IntegrationConfig["jellyfin"]> {
  const url = fieldUrl(body, "jellyfinUrl");
  const externalUrl = fieldUrl(body, "jellyfinExternalUrl");
  const apiKey = savedKeyForUrl({
    url,
    saved: current,
    supplied: optionalText(body, "jellyfinApiKey", 512),
    messages: {
      missing: "jellyfinApiKey is required.",
      moved:
        "jellyfinApiKey is required when jellyfinUrl moves to a different origin.",
    },
  });
  const jellyfin = {
    url,
    externalUrl,
    apiKey,
    serverId: current.serverId,
    libraryIds: current.libraryIds,
  };
  await checkJellyfinDraft(jellyfin);
  return jellyfin;
}

/** Omitted key preserves what is stored; present key must be complete. */
export function parseDelivery(raw: unknown): WhisparrDelivery | undefined {
  if (raw === undefined) return undefined;
  const invalid = () =>
    new AppError(400, "invalid_field", "Invalid Whisparr delivery settings.");
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid();
  }
  const d = raw as Record<string, unknown>;
  if (
    typeof d.enabled !== "boolean" ||
    typeof d.rootFolderPath !== "string" ||
    d.rootFolderPath.length > 1024 ||
    typeof d.qualityProfileId !== "number" ||
    !Number.isInteger(d.qualityProfileId) ||
    d.qualityProfileId < 1 ||
    typeof d.searchOnAdd !== "boolean" ||
    (d.enabled && d.rootFolderPath === "")
  ) {
    throw invalid();
  }
  return {
    enabled: d.enabled,
    rootFolderPath: d.rootFolderPath,
    qualityProfileId: d.qualityProfileId,
    searchOnAdd: d.searchOnAdd,
  };
}

export function parsePathMappings(
  raw: unknown,
): WhisparrPathMapping[] | undefined {
  if (raw === undefined) return undefined;
  const invalid = () =>
    new AppError(400, "invalid_field", "Invalid Whisparr path mappings.");
  if (!Array.isArray(raw) || raw.length > 50) throw invalid();
  const mapped: WhisparrPathMapping[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw invalid();
    }
    const e = entry as Record<string, unknown>;
    if (
      typeof e.whisparrPrefix !== "string" ||
      e.whisparrPrefix === "" ||
      e.whisparrPrefix.length > 1024 ||
      typeof e.jellyfinPrefix !== "string" ||
      e.jellyfinPrefix === "" ||
      e.jellyfinPrefix.length > 1024
    ) {
      throw invalid();
    }
    mapped.push({
      whisparrPrefix: e.whisparrPrefix,
      jellyfinPrefix: e.jellyfinPrefix,
    });
  }
  return mapped;
}

/** Whisparr patch: a blank URL removes the connection, delivery settings are
 * stored only with one. Omitted keys preserve what is already configured,
 * but a stored key follows the URL only within one origin. */
export function nextWhisparr(
  current: IntegrationConfig["whisparr"],
  body: Record<string, unknown>,
): IntegrationConfig["whisparr"] {
  let whisparr = current;
  const url = optionalText(body, "whisparrUrl", 2048);
  if (url === "") {
    if (optionalText(body, "whisparrApiKey", 512) !== undefined)
      throw new AppError(
        400,
        "invalid_field",
        "A Whisparr API key requires a Whisparr URL; clear the key to remove Whisparr.",
      );
    whisparr = undefined;
  } else if (url !== undefined) {
    const supplied = optionalText(body, "whisparrApiKey", 512);
    // Same origin rule as Jellyfin (savedKeyForUrl): a stored key follows
    // its URL only within one origin; a move to a new host must present the
    // key again, before any upstream call.
    const apiKey = savedKeyForUrl({
      url,
      saved: whisparr,
      supplied,
      messages: {
        missing: "Whisparr API key is required with a Whisparr URL.",
        moved:
          "Whisparr API key is required when the Whisparr URL moves to a different origin.",
      },
    });
    whisparr = { url: validateBaseUrl(url), apiKey };
  }
  const delivery = parseDelivery(body.delivery) ?? whisparr?.delivery;
  const pathMappings =
    parsePathMappings(body.pathMappings) ?? whisparr?.pathMappings;
  if (
    (body.delivery !== undefined || body.pathMappings !== undefined) &&
    !whisparr
  ) {
    throw new AppError(
      400,
      "invalid_field",
      "Whisparr must be configured to set delivery settings.",
    );
  }
  if (!whisparr) return undefined;
  return {
    ...whisparr,
    ...(delivery ? { delivery } : {}),
    ...(pathMappings ? { pathMappings } : {}),
  };
}

/** Provider-card PATCH fields: the credential/judgment values plus the
 * rejected-key clear guards. A guarded clear must stay on the
 * provider-only path — that path writes synchronously, so the
 * compare-and-set sits directly next to saveConfig; the mixed path
 * awaits Jellyfin in between and could validate a key that is already
 * gone. */
const PROVIDER_SAVE_FIELDS = [
  "tpdbApiToken",
  "stashdbApiKey",
  "typesafeApiKey",
  "judgmentProvider",
  "ollamaUrl",
  "ollamaModel",
  "tpdbApiTokenExpect",
  "stashdbApiKeyExpect",
];

const GUARDED_CLEARS = [
  {
    field: "tpdbApiToken",
    guard: "tpdbApiTokenExpect",
    provider: "tpdb",
    name: "TPDB",
    max: 1024,
  },
  {
    field: "stashdbApiKey",
    guard: "stashdbApiKeyExpect",
    provider: "stashdb",
    name: "StashDB",
    max: 512,
  },
] as const;

/** The rejected-key auto-clear must delete exactly the key its failed
 * check probed. The client echoes the check's keyFingerprint in the
 * guard field; the server compares it against the stored key as it is
 * right now and refuses (409) on any difference, so a key another tab
 * saved while the probe was in flight survives. A clear without a guard
 * (the manual clear dialog) stays unconditional. */
function guardProviderClear(body: Record<string, unknown>): void {
  const guarded = GUARDED_CLEARS.filter(
    (entry) => optionalText(body, entry.guard, 128) !== undefined,
  );
  if (guarded.length === 0) return;
  if (!Object.keys(body).every((k) => PROVIDER_SAVE_FIELDS.includes(k)))
    throw new AppError(
      400,
      "invalid_field",
      "A guarded provider clear carries provider fields only.",
    );
  for (const entry of guarded) {
    const expect = optionalText(body, entry.guard, 128)!;
    if (optionalText(body, entry.field, entry.max) !== "")
      throw new AppError(
        400,
        "invalid_field",
        `${entry.guard} guards a clear of ${entry.field}; send it only with an empty ${entry.field}.`,
      );
    if (
      !rejectedKeyClearAllowed({
        stored: storedProviderCredential(entry.provider),
        expect,
        fingerprint: credentialFingerprint,
      })
    )
      throw new AppError(
        409,
        "provider_key_mismatch",
        `The stored ${entry.name} key changed since its check failed; it was not deleted. Check the connection again.`,
      );
  }
}

export async function adminUpdateIntegrations(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const body = await readJson(request);
  // Before any write: the guard compares against the live stored key and
  // must sit directly next to the synchronous provider-only saveConfig.
  guardProviderClear(body);
  // Provider-only saves never touch Jellyfin/Whisparr: the provider card
  // sends just its fields, and re-validating the Jellyfin connection would
  // make provider keys uneditable whenever Jellyfin is briefly down.
  const bodyKeys = Object.keys(body);
  if (
    bodyKeys.length > 0 &&
    bodyKeys.every((k) => PROVIDER_SAVE_FIELDS.includes(k))
  ) {
    const providers = nextProviderCredentials(ctx.config.providers, body);
    const patched: IntegrationConfig = {
      jellyfin: ctx.config.jellyfin,
      ...(ctx.config.whisparr ? { whisparr: ctx.config.whisparr } : {}),
      ...(providers ? { providers } : {}),
    };
    saveConfig(patched);
    return json(integrationsShape(patched));
  }
  // Whisparr-only saves never touch Jellyfin either: the Whisparr card sends
  // just its fields, and re-validating the Jellyfin connection would make
  // Whisparr uneditable whenever Jellyfin is briefly down. A Jellyfin-only
  // body needs no branch: nextWhisparr preserves a Whisparr the body omits.
  if (
    bodyKeys.length > 0 &&
    bodyKeys.every((k) =>
      ["whisparrUrl", "whisparrApiKey", "delivery", "pathMappings"].includes(k),
    )
  ) {
    const whisparr = nextWhisparr(ctx.config.whisparr, body);
    const patched: IntegrationConfig = {
      jellyfin: ctx.config.jellyfin,
      ...(whisparr ? { whisparr } : {}),
      ...(ctx.config.providers ? { providers: ctx.config.providers } : {}),
    };
    saveConfig(patched);
    return json(integrationsShape(patched));
  }
  const jellyfin = await nextJellyfin(ctx.config.jellyfin, body);
  const whisparr = nextWhisparr(ctx.config.whisparr, body);
  const providers = nextProviderCredentials(ctx.config.providers, body);
  const config: IntegrationConfig = {
    jellyfin,
    ...(whisparr ? { whisparr } : {}),
    ...(providers ? { providers } : {}),
  };
  saveConfig(config);
  return json(integrationsShape(config));
}

/** Upstream rejection or outage is status information, never a dead Velvarr
 * session: an HTTP 401 here would fire the client's global sign-out and
 * bounce the admin off the settings page in a loop. Storage, decryption, and
 * local configuration failures keep their original HTTP error. */
async function upstreamAsStatus(
  probe: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await probe();
  } catch (err) {
    if (err instanceof AppError && err.status >= 400) {
      return {
        configured: true,
        error: { code: err.code, message: err.message },
      };
    }
    throw err;
  }
}

export async function adminWhisparr(ctx: AuthContext): Promise<Response> {
  return json(await upstreamAsStatus(() => getWhisparrStatus(ctx.config)));
}
export async function adminJellyfin(ctx: AuthContext): Promise<Response> {
  return json(await upstreamAsStatus(() => getJellyfinStatus(ctx.config)));
}

export async function adminProviders(_ctx: AuthContext): Promise<Response> {
  const [tpdb, stashdb] = await Promise.all([
    getProviderStatus("tpdb"),
    getProviderStatus("stashdb"),
  ]);
  return json({ providers: [tpdb, stashdb] });
}

/** Only upstream failures are credential-status data. Storage, decryption,
 * and local configuration failures retain their original HTTP error.
 * keyFingerprint marks a rejected STORED credential: it lets the client's
 * auto-clear prove, on the server, that the key it deletes is the exact
 * key this check rejected (see guardProviderClear). */
export function providerCheckFailure(
  provider: CredentialProvider,
  error: unknown,
  keyFingerprint?: string,
): ProviderCheck {
  const upstreamCodes = new Set([
    "upstream_auth",
    "upstream_forbidden",
    "upstream_not_found",
    "upstream_unavailable",
    "upstream_timeout",
    "upstream_bad_response",
  ]);
  if (!(error instanceof AppError) || !upstreamCodes.has(error.code))
    throw error;
  return {
    provider,
    configured: true,
    verified: false,
    error: { code: error.code, message: error.message },
    ...(keyFingerprint !== undefined ? { keyFingerprint } : {}),
  };
}

export async function adminProviderCheck(
  _ctx: AuthContext,
  raw: string,
): Promise<Response> {
  if (raw !== "tpdb" && raw !== "stashdb") {
    throw new AppError(400, "invalid_provider", "Unknown credential provider.");
  }
  const provider = raw;
  // The fingerprint must describe the credential the probe uses. Read it
  // before the probe and in the same tick: credential() resolves its
  // stored value synchronously before the first upstream await, so this
  // always matches what the probe sent — or is absent with an environment
  // fallback, which the auto-clear never touches.
  const stored = storedProviderCredential(provider);
  const keyFingerprint =
    stored === undefined ? undefined : credentialFingerprint(stored);
  try {
    return json(await getProviderStatus(provider));
  } catch (err) {
    return json(providerCheckFailure(provider, err, keyFingerprint));
  }
}

/** --- draft connection tests (POST .../test) ---
 * Validated exactly like the save path — including the origin rule on the
 * stored key and, for Jellyfin, checkJellyfinDraft's server-identity and
 * user-enumeration checks — and persisted nowhere: nothing reaches storage,
 * so the rejected-key auto-delete can never run on a test result. A blank
 * secret field means "use the saved secret" within the saved URL's origin.
 * Upstream failures come back inside a 200 status (never a 401, which would
 * sign the admin out). */

export async function adminProviderTest(
  request: Request,
  raw: string,
): Promise<Response> {
  if (raw !== "tpdb" && raw !== "stashdb") {
    throw new AppError(400, "invalid_provider", "Unknown credential provider.");
  }
  const provider = raw;
  const body = await readJson(request);
  // The save path's token rules: the same caps as nextProviderCredentials,
  // and a trimmed value. Blank or omitted tests the saved credential.
  const key = optionalText(body, "key", provider === "tpdb" ? 1024 : 512);
  const override =
    key !== undefined && key.trim() !== "" ? key.trim() : undefined;
  try {
    return json(await getProviderStatus(provider, override));
  } catch (err) {
    return json(providerCheckFailure(provider, err));
  }
}

export async function adminJellyfinTest(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const body = await readJson(request);
  const url = fieldUrl(body, "url");
  const suppliedExternal = optionalText(body, "externalUrl", 2048);
  // The same origin rule as the save path: a blank key reuses the saved one
  // only within one origin, so the stored secret never reaches a new host.
  const apiKey = savedKeyForUrl({
    url,
    saved: ctx.config.jellyfin,
    supplied: optionalText(body, "apiKey", 512),
    messages: {
      missing: "jellyfinApiKey is required.",
      moved:
        "jellyfinApiKey is required when jellyfinUrl moves to a different origin.",
    },
  });
  // The draft: saved values wherever the form is blank. The test keeps no
  // state: the upstream verdict is the answer, stored nowhere.
  const jellyfin = {
    ...ctx.config.jellyfin,
    url,
    externalUrl:
      suppliedExternal !== undefined && suppliedExternal.trim() !== ""
        ? validateBaseUrl(suppliedExternal)
        : "",
    apiKey,
  };
  // The save path's upstream checks run first: the draft must reach the
  // stored server identity, and its key must enumerate users. A refusal is
  // status data inside the 200, like any upstream rejection.
  return json(
    await upstreamAsStatus(async () => {
      await checkJellyfinDraft(jellyfin);
      return getJellyfinStatus({ ...ctx.config, jellyfin });
    }),
  );
}

export async function adminWhisparrTest(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const body = await readJson(request);
  const rawUrl = optionalText(body, "url", 2048);
  const suppliedKey = optionalText(body, "apiKey", 512);
  // The save path's rule: a key without a URL is a malformed draft.
  if (
    (rawUrl === undefined || rawUrl.trim() === "") &&
    suppliedKey !== undefined &&
    suppliedKey.trim() !== ""
  ) {
    throw new AppError(
      400,
      "invalid_field",
      "A Whisparr API key requires a Whisparr URL; clear the key to remove Whisparr.",
    );
  }
  // A blank URL means "no Whisparr": the draft removes it, like a save would.
  if (rawUrl === undefined || rawUrl.trim() === "") {
    return json(
      await getWhisparrStatus({ ...ctx.config, whisparr: undefined }),
    );
  }
  const whisparrDraftUrl = validateBaseUrl(rawUrl);
  const whisparr = {
    ...ctx.config.whisparr,
    url: whisparrDraftUrl,
    // The same origin rule as the save path: a blank key reuses the saved
    // one only within one origin, before any upstream call.
    apiKey: savedKeyForUrl({
      url: whisparrDraftUrl,
      saved: ctx.config.whisparr,
      supplied: suppliedKey,
      messages: {
        missing: "Whisparr API key is required with a Whisparr URL.",
        moved:
          "Whisparr API key is required when the Whisparr URL moves to a different origin.",
      },
    }),
  };
  return json(
    await upstreamAsStatus(() =>
      getWhisparrStatus({ ...ctx.config, whisparr }),
    ),
  );
}

import type { RouteDef } from "../admission.ts";

export const routes: RouteDef[] = [
  {
    method: "GET",
    segments: ["admin", "users"],
    auth: "admin",
    run: async (ctx) => adminUsers(ctx),
  },
  {
    method: "GET",
    segments: ["admin", "users", ":id", "avatar"],
    auth: "admin",
    exemptFromBudget: true,
    run: async (ctx, _request, p) => userAvatar(ctx, p.id!),
  },
  {
    method: "GET",
    segments: ["admin", "integrations"],
    auth: "admin",
    run: async (ctx) => json(integrationsShape(ctx.config)),
  },
  {
    method: "GET",
    segments: ["admin", "whisparr"],
    auth: "admin",
    run: async (ctx) => adminWhisparr(ctx),
  },
  {
    method: "GET",
    segments: ["admin", "jellyfin"],
    auth: "admin",
    run: async (ctx) => adminJellyfin(ctx),
  },
  {
    method: "GET",
    segments: ["admin", "providers"],
    auth: "admin",
    run: async (ctx) => adminProviders(ctx),
  },
  {
    method: "GET",
    segments: ["admin", "providers", ":provider"],
    auth: "admin",
    run: async (ctx, _request, p) => adminProviderCheck(ctx, p.provider!),
  },
  {
    method: "POST",
    segments: ["admin", "judgment", "check"],
    auth: "admin",
    run: async (ctx) =>
      json(await checkJudgmentConnection(ctx.config.providers)),
  },
  {
    method: "POST",
    segments: ["admin", "providers", ":provider", "test"],
    auth: "admin",
    run: async (_ctx, request, p) => adminProviderTest(request, p.provider!),
  },
  {
    method: "POST",
    segments: ["admin", "jellyfin", "test"],
    auth: "admin",
    run: async (ctx, request) => adminJellyfinTest(request, ctx),
  },
  {
    method: "POST",
    segments: ["admin", "whisparr", "test"],
    auth: "admin",
    run: async (ctx, request) => adminWhisparrTest(request, ctx),
  },
  {
    method: "POST",
    segments: ["admin", "users", "import"],
    auth: "admin",
    run: async (ctx, request) => adminImport(request, ctx),
  },
  {
    method: "PATCH",
    segments: ["admin", "users", ":id"],
    auth: "admin",
    run: async (ctx, request, p) => adminUpdateUser(request, ctx, p.id!),
  },
  {
    method: "PATCH",
    segments: ["admin", "integrations"],
    auth: "admin",
    run: async (ctx, request) => adminUpdateIntegrations(request, ctx),
  },
];
