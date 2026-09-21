// Shared loopback fixture: one 127.0.0.1 HTTP server the integration-style
// suites point an IntegrationConfig at. The substitutable seam is the config
// base URL, so nothing here stubs fetch or patches a module — an upstream is
// simply a small server that answers on localhost and records what it was
// asked. Suites bring their own request handlers and assertions; this module
// owns only the parts four suites were each keeping their own copy of.

import http from "node:http";
import type { AddressInfo } from "node:net";

import { AppError } from "../src/server/http.ts";
import type { Account, IntegrationConfig } from "../src/lib/contracts.ts";

// Fixed identities. Hex-shaped because Jellyfin ids are 32-hex and the
// normalizer rejects anything else; distinct letters make a failing assertion
// legible at a glance.
export const SERVER_ID = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
export const ME_ID = "b".repeat(32);
/** The requester's own Jellyfin access token. */
export const TOKEN = "u".repeat(32);
/** The integration administrator key — never interchangeable with TOKEN. */
export const ADMIN_KEY = "a".repeat(32);
export const WH_KEY = "w".repeat(32);
export const LIB_A = "aa11".repeat(8);
export const LIB_B = "bb22".repeat(8);
export const LIB_C = "cc33".repeat(8);
export const ITEM_ID = "d".repeat(32);

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type FixtureHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
) => void;

export interface Fixture {
  origin: string;
  log: RecordedRequest[];
  close: () => Promise<void>;
}

/** Jellyfin reports ids dashed in some payloads and bare in others; suites
 * need both spellings of the same id to prove the normalizer. */
export function dashed(id: string): string {
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`;
}

export function hexId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

export function sendJson(
  res: http.ServerResponse,
  status: number,
  value: unknown,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

export function sendBytes(
  res: http.ServerResponse,
  status: number,
  bytes: Buffer,
  contentType: string,
): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(bytes);
}

export function pathOf(url: string): string {
  return (url.split("?")[0] ?? "").toLowerCase();
}

export function queryOf(url: string): URLSearchParams {
  return new URLSearchParams(url.split("?")[1] ?? "");
}

/** Predicate for assert.rejects: pins status AND code, so a refactor that
 * keeps the status but renames the code still fails. */
export function appError(
  status: number,
  code: string,
): (err: unknown) => boolean {
  return (err) =>
    err instanceof AppError && err.status === status && err.code === code;
}

export function jellyfinConfig(
  origin: string,
  libraryIds: string[],
): IntegrationConfig {
  return {
    jellyfin: {
      url: origin,
      externalUrl: `${origin}/jf`,
      apiKey: ADMIN_KEY,
      serverId: SERVER_ID,
      libraryIds,
    },
  };
}

export function whisparrConfig(origin: string): IntegrationConfig {
  return {
    jellyfin: {
      url: origin,
      externalUrl: origin,
      apiKey: ADMIN_KEY,
      serverId: SERVER_ID,
      libraryIds: [],
    },
    whisparr: { url: origin, apiKey: WH_KEY },
  };
}

export function account(libraryIds: string[]): Account {
  return {
    id: "acct-1",
    name: "bob",
    role: "requester",
    enabled: true,
    libraryIds,
    isOwner: false,
    autoApprove: false,
    canRemove: false,
    joinedAt: 0,
  };
}

/** Port 0 so suites can run concurrently; every request is logged before the
 * handler sees it, and a handler that throws answers 500 with the reason
 * instead of hanging the socket and timing the test out. */
export function startFixture(handler: FixtureHandler): Promise<Fixture> {
  const { promise, resolve, reject } = Promise.withResolvers<Fixture>();
  const log: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    res.on("error", () => {});
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      log.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body,
      });
      try {
        handler(req, res, body);
      } catch (err) {
        sendJson(res, 500, { fixtureError: String(err) });
      }
    });
  });
  server.on("error", reject);
  server.on("clientError", (_err, socket) => socket.destroy());
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({
      origin: `http://127.0.0.1:${address.port}`,
      log,
      close: () => {
        server.closeAllConnections();
        const done = Promise.withResolvers<void>();
        server.close(() => done.resolve());
        return done.promise;
      },
    });
  });
  return promise;
}

/** Closes the fixture even when the body throws, so one failing case cannot
 * leave a listening socket behind and cascade into the next. */
export async function withFixture(
  handler: FixtureHandler,
  run: (fx: Fixture) => Promise<void>,
): Promise<void> {
  const fx = await startFixture(handler);
  try {
    await run(fx);
  } finally {
    await fx.close();
  }
}
