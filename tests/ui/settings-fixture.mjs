// Shared Connections and Metadata providers API fixture. The app
// serves its real UI/assets; these synthetic responses exercise UI behavior.
// Server-side persistence, authorization and upstream calls are covered by
// tests/api.test.ts and tests/integrations.test.ts, not by this mock server.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const data = mkdtempSync(join(tmpdir(), "velvarr-settings-ui-"));
const app = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "16740",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      VELVARR_DATA_DIR: data,
      VELVARR_SECRET_KEY: randomBytes(32).toString("hex"),
      VELVARR_SETUP_SECRET: randomBytes(32).toString("hex"),
      TPDB_API_TOKEN: "",
      STASHDB_API_KEY: "",
      TYPESAFE_API_KEY: "",
      VELVARR_JUDGMENT_PROVIDER: "none",
    },
  },
);
const initial = () => ({
  jellyfin: {
    url: "http://jellyfin.review:8096",
    externalUrl: "https://media.example.test",
    serverId: "review-server",
    libraryIds: ["review-library"],
    apiKeyConfigured: true,
  },
  whisparr: {
    url: "http://whisparr.review:6969",
    apiKeyConfigured: true,
    delivery: {
      enabled: true,
      rootFolderPath: "/data/media",
      qualityProfileId: 1,
      searchOnAdd: true,
    },
    pathMappings: [{ whisparrPrefix: "/data/media", jellyfinPrefix: "/media" }],
  },
  providers: {
    tpdb: { configured: true, source: "stored" },
    stashdb: { configured: true, source: "stored" },
    typesafe: { configured: true, source: "stored" },
  },
  judgment: {
    provider: "typesafe",
    url: "http://localhost:11434",
    model: "review-model",
    configured: true,
    stored: true,
  },
});
let config = initial(),
  mode = {},
  requests = [],
  generation = 0;
const heldConfig = new Set(),
  heldPatch = new Set(),
  heldProbe = new Set();
const release = (pending) => {
  for (const resolve of pending) resolve();
  pending.clear();
};
const hold = (pending) => new Promise((resolve) => pending.add(resolve));
const json = (res, code, body) => {
  res.writeHead(code, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
};
const error = (res, status, message) =>
  json(res, status, { error: { code: "review_fixture", message } });
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (path === "/__settings_test") {
    if (req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      const update = JSON.parse(body || "{}");
      if (update.reset) {
        generation++;
        config = initial();
        mode = {};
        requests = [];
        release(heldConfig);
        release(heldPatch);
        release(heldProbe);
      }
      if (update.config) config = update.config;
      Object.assign(mode, update);
      if (!mode.holdConfig) release(heldConfig);
      if (!mode.holdPatch) release(heldPatch);
      if (!mode.holdProbe) release(heldProbe);
    }
    return json(res, 200, { mode, config, requests });
  }
  if (path === "/__settings_test/ready") {
    try {
      const ready = await fetch("http://127.0.0.1:16740/");
      return json(res, ready.ok ? 200 : 503, { ready: ready.ok });
    } catch {
      return json(res, 503, { ready: false });
    }
  }
  if (path.startsWith("/api/")) {
    const requestGeneration = generation;
    let body = "";
    for await (const c of req) body += c;
    const request = {
      path,
      method: req.method,
      body: body ? JSON.parse(body) : null,
      started: Date.now(),
    };
    requests.push(request);
    res.on("finish", () => (request.finished = Date.now()));
    if (path === "/api/status")
      return json(res, 200, { initialized: true, setupReady: false });
    if (path === "/api/me")
      return json(res, 200, {
        account: {
          id: "review-admin",
          name: "Review admin",
          role: "admin",
          enabled: true,
          isOwner: true,
          autoApprove: false,
          libraryIds: ["review-library"],
          joinedAt: 0,
        },
        providers: {
          tpdb: "configured",
          stashdb: "configured",
          typesafe: "configured",
        },
      });
    if (path === "/api/me/avatar") return res.writeHead(404).end();
    if (path === "/api/update")
      return json(res, 200, {
        currentVersion: "0.41.0",
        latestVersion: "0.41.0",
        updateAvailable: false,
      });
    if (path === "/api/requests") return json(res, 200, { requests: [] });
    if (path === "/api/admin/integrations") {
      if (req.method === "GET" && mode.holdConfig) await hold(heldConfig);
      if (requestGeneration !== generation)
        return error(res, 409, "Obsolete test request.");
      if (mode.config403) return error(res, 403, "Administrators only.");
      if (req.method === "PATCH") {
        if (mode.holdPatch) await hold(heldPatch);
        if (requestGeneration !== generation)
          return error(res, 409, "Obsolete test request.");
        if (mode.patchFail)
          return error(
            res,
            503,
            "Changes could not be saved. Please try again.",
          );
        const b = JSON.parse(body);
        if ("jellyfinUrl" in b) config.jellyfin.url = b.jellyfinUrl;
        if ("jellyfinExternalUrl" in b)
          config.jellyfin.externalUrl = b.jellyfinExternalUrl;
        if (b.jellyfinApiKey) config.jellyfin.apiKeyConfigured = true;
        if ("whisparrUrl" in b)
          config.whisparr = b.whisparrUrl
            ? { ...config.whisparr, url: b.whisparrUrl, apiKeyConfigured: true }
            : null;
        if (config.whisparr) {
          if ("delivery" in b) config.whisparr.delivery = b.delivery;
          if ("pathMappings" in b)
            config.whisparr.pathMappings = b.pathMappings;
        }
        for (const [key, id] of [
          ["tpdbApiToken", "tpdb"],
          ["stashdbApiKey", "stashdb"],
          ["typesafeApiKey", "typesafe"],
        ])
          if (key in b)
            config.providers[id] = {
              configured: Boolean(b[key] || mode.environmentProviders?.[id]),
              source: b[key] ? "stored" : "environment",
            };
        if ("judgmentProvider" in b)
          config.judgment = {
            ...config.judgment,
            provider:
              b.judgmentProvider ||
              mode.environmentJudgment?.provider ||
              "typesafe",
            configured: b.judgmentProvider !== "none",
            stored: !!b.judgmentProvider,
          };
        if ("ollamaUrl" in b)
          config.judgment.url =
            b.ollamaUrl ||
            mode.environmentJudgment?.url ||
            "http://localhost:11434";
        if ("ollamaModel" in b)
          config.judgment.model =
            b.ollamaModel || mode.environmentJudgment?.model || "review-model";
        config.judgment.configured =
          config.judgment.provider === "typesafe"
            ? config.providers.typesafe.configured
            : config.judgment.provider === "ollama"
              ? !!(config.judgment.url && config.judgment.model)
              : false;
        return json(res, 200, config);
      }
      if (mode.configFail)
        return error(
          res,
          503,
          "The settings service is temporarily unavailable. Your connection checks are still available.",
        );
      return json(res, 200, config);
    }
    if (path === "/api/admin/jellyfin" || path === "/api/admin/whisparr") {
      const service = path.split("/").at(-1);
      if (mode.holdProbe) await hold(heldProbe);
      if (requestGeneration !== generation)
        return error(res, 409, "Obsolete test request.");
      if (mode[service + "403"]) return error(res, 403, "Administrators only.");
      if (mode[service + "HttpFail"])
        return error(res, 503, "The review status endpoint is unavailable.");
      if (mode[service + "Fail"])
        return json(res, 200, {
          configured: true,
          error: {
            code: "unreachable",
            message: "The review " + service + " server could not be reached.",
          },
        });
      if (service === "whisparr" && !config.whisparr)
        return json(res, 200, { configured: false });
      return json(
        res,
        200,
        service === "jellyfin"
          ? {
              configured: true,
              serverName: "Review media server",
              version: "12.0.0",
            }
          : {
              configured: true,
              appName: "Whisparr",
              version: "3.0.0",
              rootFolders: [
                { id: 1, path: "/data/media" },
                { id: 2, path: "/data/alt" },
              ],
              profiles: [
                { id: 1, name: "HD / UHD" },
                { id: 2, name: "Any" },
              ],
            },
      );
    }
    if (path.startsWith("/api/admin/providers/")) {
      const provider = path.split("/").at(-1);
      if (mode.holdProbe) await hold(heldProbe);
      if (requestGeneration !== generation)
        return error(res, 409, "Obsolete test request.");
      if (mode[provider + "403"])
        return error(res, 403, "Administrators only.");
      if (mode[provider + "HttpFail"])
        return error(
          res,
          503,
          "The synthetic provider status endpoint is unavailable.",
        );
      if (mode[provider + "Fail"])
        return json(res, 200, {
          provider,
          configured: true,
          verified: false,
          error: {
            code: "upstream_auth",
            message: "The synthetic " + provider + " credential was rejected.",
          },
        });
      return json(
        res,
        200,
        config.providers[provider]?.configured
          ? {
              provider,
              configured: true,
              verified: true,
              account: "Review account",
            }
          : { provider, configured: false },
      );
    }
    if (path === "/api/admin/judgment/check") {
      if (mode.holdProbe) await hold(heldProbe);
      if (requestGeneration !== generation)
        return error(res, 409, "Obsolete test request.");
      if (mode.judgment403) return error(res, 403, "Administrators only.");
      return json(res, 200, {
        provider: config.judgment.provider,
        connected: !mode.judgmentFail,
        ...(mode.judgmentFail
          ? { error: "The synthetic AI service is unavailable." }
          : {}),
      });
    }
    return error(res, 404, "Unexpected test API route: " + path);
  }
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: 16740,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: "127.0.0.1:16740" },
    },
    (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () =>
    json(res, 502, { error: "Production UI unavailable" }),
  );
  req.pipe(upstream);
});
server.listen(16741, "127.0.0.1");
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  release(heldConfig);
  release(heldPatch);
  release(heldProbe);
  server.closeAllConnections();
  server.close();
  app.kill("SIGTERM");
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
app.once("exit", (code) => {
  server.closeAllConnections();
  server.close();
  rmSync(data, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  process.exit(stopping ? 0 : code || 1);
});
