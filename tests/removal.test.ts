// M7 removal tests: Jellyfin user-token-only item deletion against isolated
// 127.0.0.1 HTTP fixtures. No real network, no real credentials, no real
// media touched — every request stays on loopback. Proves: the delete runs
// under the requester's own token and never the integration API key, a user
// whose policy lacks EnableContentDeletion is denied before any DELETE,
// ungranted-library items are refused before any DELETE, a proven 404 is
// success, a proven 401/403 is denial, and 5xx/timeout are uncertain.

import test from "node:test";
import assert from "node:assert/strict";

import { deleteLibraryItem } from "../src/server/jellyfin.ts";
import { AppError } from "../src/server/http.ts";
import {
  ADMIN_KEY,
  ITEM_ID,
  LIB_A,
  LIB_B,
  LIB_C,
  ME_ID,
  TOKEN,
  account,
  dashed,
  jellyfinConfig,
  pathOf,
  queryOf,
  sendJson,
  withFixture,
} from "./fixture.ts";
import type { Fixture, FixtureHandler, RecordedRequest } from "./fixture.ts";

// --- suite-specific upstream scenarios ---

const ME_CAN_DELETE = {
  Id: ME_ID,
  Name: "bob",
  Policy: {
    IsAdministrator: false,
    IsDisabled: false,
    EnableRemoteAccess: true,
    EnableMediaPlayback: true,
    EnableContentDeletion: true,
  },
};

const ME_NO_DELETE = {
  ...ME_CAN_DELETE,
  Policy: { ...ME_CAN_DELETE.Policy, EnableContentDeletion: false },
};

// Standard removal fixture: /Users/Me identity, ids-scoped item visibility
// (the lab build ignores parentId alongside ids), the ancestor chain placing
// the item in LIB_B, and a DELETE route with scripted status.
function removalHandler(opts: {
  me?: Record<string, unknown>;
  ancestors?: unknown[];
  deleteStatus?: number;
  deleteDelayMs?: number;
}): FixtureHandler {
  return (req, res) => {
    const url = req.url ?? "";
    const path = pathOf(url);
    if (path === "/users/me") {
      return sendJson(res, 200, opts.me ?? ME_CAN_DELETE);
    }
    if (path === `/users/${ME_ID}/items`) {
      const found = queryOf(url).get("ids") === ITEM_ID;
      return sendJson(res, 200, {
        Items: found
          ? [
              {
                Id: dashed(ITEM_ID),
                Name: "Lab Movie",
                Type: "Movie",
                LocationType: "FileSystem",
                Path: "/mnt/lab/movie.mkv",
                MediaSources: [
                  { Id: "ms1", Path: "/mnt/lab/movie.mkv", Size: 1500 },
                  { Id: "ms2", Path: "/mnt/lab/extra.mkv", Size: 500 },
                ],
              },
            ]
          : [],
        TotalRecordCount: found ? 1 : 0,
      });
    }
    if (path === `/items/${ITEM_ID}/ancestors`) {
      return sendJson(
        res,
        200,
        opts.ancestors ?? [
          { Id: dashed(LIB_A), Name: "Root", Type: "Folder" },
          { Id: dashed(LIB_B), Name: "Movies", Type: "CollectionFolder" },
        ],
      );
    }
    if (path === `/items/${ITEM_ID}` && req.method === "DELETE") {
      const status = opts.deleteStatus ?? 204;
      // Real wall-clock delay is the only way to exercise the transport's
      // own AbortController deadline; fake timers cannot stall a socket.
      if (opts.deleteDelayMs) {
        setTimeout(() => sendJson(res, status, {}), opts.deleteDelayMs);
        return;
      }
      return sendJson(res, status, {});
    }
    sendJson(res, 404, {});
  };
}

// The admin key must never travel in ANY request this code makes, under any
// header name or encoding.
function assertNoAdminKey(fx: Fixture): void {
  for (const r of fx.log) {
    const serialized = JSON.stringify(r.headers).toLowerCase();
    assert.equal(
      serialized.includes(ADMIN_KEY),
      false,
      `admin key leaked in request ${r.method} ${r.url}: ${serialized}`,
    );
    assert.equal(r.headers["x-api-key"], undefined);
  }
}

function deleteRequests(fx: Fixture): RecordedRequest[] {
  return fx.log.filter(
    (r) => r.method === "DELETE" && pathOf(r.url) === `/items/${ITEM_ID}`,
  );
}

// --- happy path: delete under the requester's own token ---

test("deleteLibraryItem deletes under the user token and returns audit facts", async () => {
  await withFixture(removalHandler({}), async (fx) => {
    const outcome = await deleteLibraryItem(
      jellyfinConfig(fx.origin, [LIB_B]),
      { token: TOKEN },
      account([LIB_B]),
      ITEM_ID,
    );
    assert.deepEqual(outcome, {
      status: "removed",
      facts: {
        itemId: ITEM_ID,
        name: "Lab Movie",
        libraryId: LIB_B,
        libraryName: "Movies",
        paths: ["/mnt/lab/movie.mkv", "/mnt/lab/extra.mkv"],
        size: 2000,
      },
      watchLinkInvalid: true,
    });
    // Exactly one DELETE, authenticated ONLY by the requester's own token in
    // the MediaBrowser authorization header.
    const deletes = deleteRequests(fx);
    assert.equal(deletes.length, 1);
    const auth = deletes[0]!.headers.authorization ?? "";
    assert.match(auth, /^MediaBrowser Client="Velvarr"/);
    assert.ok(auth.includes(`Token="${TOKEN}"`));
    assert.equal(deletes[0]!.headers["x-api-key"], undefined);
    assertNoAdminKey(fx);
  });
});

// --- policy denial before any DELETE ---

test("deleteLibraryItem names the missing EnableContentDeletion and never deletes", async () => {
  await withFixture(removalHandler({ me: ME_NO_DELETE }), async (fx) => {
    await assert.rejects(
      deleteLibraryItem(
        jellyfinConfig(fx.origin, [LIB_A, LIB_B]),
        { token: TOKEN },
        account([LIB_A, LIB_B]),
        ITEM_ID,
      ),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 403);
        assert.equal(err.code, "deletion_forbidden");
        assert.match(err.message, /EnableContentDeletion/);
        return true;
      },
    );
    assert.equal(deleteRequests(fx).length, 0);
    assertNoAdminKey(fx);
  });
});

// --- grant scope enforced before any DELETE ---

test("deleteLibraryItem refuses items outside granted libraries before deleting", async () => {
  await withFixture(
    removalHandler({ ancestors: [{ Id: dashed(LIB_C), Name: "Other" }] }),
    async (fx) => {
      await assert.rejects(
        deleteLibraryItem(
          jellyfinConfig(fx.origin, [LIB_A, LIB_B]),
          { token: TOKEN },
          account([LIB_A, LIB_B]),
          ITEM_ID,
        ),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.status, 404);
          assert.equal(err.code, "item_not_found");
          return true;
        },
      );
      assert.equal(deleteRequests(fx).length, 0);
      assertNoAdminKey(fx);
    },
  );
});

test("deleteLibraryItem denies empty grants with zero upstream calls", async () => {
  await withFixture(removalHandler({}), async (fx) => {
    await assert.rejects(
      deleteLibraryItem(
        jellyfinConfig(fx.origin, [LIB_A]),
        { token: TOKEN },
        account([]),
        ITEM_ID,
      ),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "item_not_found");
        return true;
      },
    );
    assert.equal(fx.log.length, 0);
  });
});

// --- outcome semantics ---

test("deleteLibraryItem treats a proven 404 as already-gone success", async () => {
  await withFixture(removalHandler({ deleteStatus: 404 }), async (fx) => {
    const outcome = await deleteLibraryItem(
      jellyfinConfig(fx.origin, [LIB_A, LIB_B]),
      { token: TOKEN },
      account([LIB_A, LIB_B]),
      ITEM_ID,
    );
    assert.ok(outcome.status === "already_gone");
    assert.equal(outcome.watchLinkInvalid, true);
    assertNoAdminKey(fx);
  });
});

test("deleteLibraryItem reports a proven 401/403 as denial", async () => {
  for (const status of [401, 403]) {
    await withFixture(removalHandler({ deleteStatus: status }), async (fx) => {
      const outcome = await deleteLibraryItem(
        jellyfinConfig(fx.origin, [LIB_A, LIB_B]),
        { token: TOKEN },
        account([LIB_A, LIB_B]),
        ITEM_ID,
      );
      assert.equal(outcome.status, "denied");
      assert.ok(outcome.reason.length > 0);
      assertNoAdminKey(fx);
    });
  }
});

test("deleteLibraryItem reports a 5xx as uncertain", async () => {
  await withFixture(removalHandler({ deleteStatus: 500 }), async (fx) => {
    const outcome = await deleteLibraryItem(
      jellyfinConfig(fx.origin, [LIB_A, LIB_B]),
      { token: TOKEN },
      account([LIB_A, LIB_B]),
      ITEM_ID,
    );
    assert.equal(outcome.status, "uncertain");
    assertNoAdminKey(fx);
  });
});

test("deleteLibraryItem reports a timeout as uncertain", async () => {
  await withFixture(removalHandler({ deleteDelayMs: 5_000 }), async (fx) => {
    const outcome = await deleteLibraryItem(
      jellyfinConfig(fx.origin, [LIB_A, LIB_B]),
      { token: TOKEN },
      account([LIB_A, LIB_B]),
      ITEM_ID,
      50,
    );
    assert.equal(outcome.status, "uncertain");
    assertNoAdminKey(fx);
  });
});
