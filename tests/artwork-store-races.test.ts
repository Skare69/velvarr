import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test, type TestContext } from "node:test";
import fc from "fast-check";
import {
  lookupArtworkVariant,
  rememberArtworkVariant,
} from "../src/server/artwork-store.ts";
import { ARTWORK_VARIANT } from "../src/lib/contracts.ts";
import { testTempDir } from "./setup.ts";

// This suite imports no providers. Node runs it in its own test process.
const real = {
  openSync: fs.openSync,
  fstatSync: fs.fstatSync,
  statSync: fs.statSync,
  readFileSync: fs.readFileSync,
  closeSync: fs.closeSync,
  futimesSync: fs.futimesSync,
};
const bytes = Buffer.from("opened artwork variant");
const hash = createHash("sha256").update("fixture source").digest("hex");
const otherHash = createHash("sha256")
  .update("replacement source")
  .digest("hex");

function put(file: string, content: string | Uint8Array, age = 60_000): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  const time = new Date(Date.now() - age);
  fs.utimesSync(file, time, time);
}

function snapshot(file: string) {
  const fd = real.openSync(file, "r");
  try {
    return {
      bytes: real.readFileSync(fd),
      mtimeMs: real.fstatSync(fd).mtimeMs,
    };
  } finally {
    real.closeSync(fd);
  }
}

function fixture(t: TestContext) {
  const saved = process.env.VELVARR_DATA_DIR;
  const root = testTempDir("artwork-store-races-");
  process.env.VELVARR_DATA_DIR = root;
  const url = "https://artwork.invalid/poster.png";
  const index = path.join(
    root,
    "artwork",
    "index",
    createHash("sha256").update(url).digest("hex"),
  );
  const variantFor = (value: string) =>
    path.join(
      root,
      "artwork",
      value.slice(0, 2),
      `${value}-200${ARTWORK_VARIANT}.webp`,
    );
  const variant = variantFor(hash);
  put(index, hash);
  put(variant, bytes);

  const opened = new Map<number, string>();
  t.mock.method(
    fs,
    "openSync",
    (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = real.openSync(file, flags, mode);
      if (typeof file === "string" && file.startsWith(root + path.sep)) {
        opened.set(fd, file);
      }
      return fd;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (saved === undefined) delete process.env.VELVARR_DATA_DIR;
    else process.env.VELVARR_DATA_DIR = saved;
  });

  return {
    url,
    index,
    variant,
    variantFor,
    matches: (target: string, value: fs.PathOrFileDescriptor) =>
      value === target ||
      (typeof value === "number" && opened.get(value) === target),
    assertClosed: () => {
      for (const fd of opened.keys()) {
        assert.throws(
          () => real.fstatSync(fd),
          { code: "EBADF" },
          "a cache operation must release its open files",
        );
      }
    },
  };
}

function afterMetadata(
  t: TestContext,
  cache: {
    matches(target: string, value: fs.PathOrFileDescriptor): boolean;
  },
  file: string,
  action: () => void,
) {
  let observed = false;
  const visit = (value: fs.PathOrFileDescriptor) => {
    if (!observed && cache.matches(file, value)) {
      observed = true;
      action();
    }
  };
  // The path hook also drives the pre-fix implementation's regression.
  t.mock.method(fs, "statSync", (value: fs.PathLike) => {
    const st = real.statSync(value);
    visit(value);
    return st;
  });
  t.mock.method(fs, "fstatSync", (fd: number) => {
    const st = real.fstatSync(fd);
    visit(fd);
    return st;
  });
  syncBuiltinESMExports();
  return () => observed;
}

for (const kind of ["variant", "index"] as const) {
  test(`artwork ${kind}: replacement after metadata cannot supply bytes or receive a touch`, (t) => {
    const cache = fixture(t);
    const target = cache[kind];
    const saved = `${target}.opened`;
    const openedMtime = snapshot(target).mtimeMs;
    const replacement =
      kind === "index"
        ? Buffer.from(otherHash)
        : Buffer.from("replacement variant");
    put(cache.variantFor(otherHash), Buffer.from("other hash variant"));
    let replacementMtime = 0;
    const observed = afterMetadata(t, cache, target, () => {
      fs.renameSync(target, saved);
      put(target, replacement, 40 * 24 * 60 * 60_000);
      replacementMtime = snapshot(target).mtimeMs;
    });

    const hit = lookupArtworkVariant(cache.url, 200);
    assert.equal(
      observed(),
      true,
      "the fixture must replace the observed file",
    );
    assert.equal(
      hit?.hash,
      hash,
      "a replacement index must not select another source hash",
    );
    assert.deepEqual(
      hit?.bytes,
      bytes,
      "a replacement must not supply bytes under the opened file's metadata",
    );
    assert.deepEqual(snapshot(target).bytes, replacement);
    assert.equal(
      snapshot(target).mtimeMs,
      replacementMtime,
      "lookup must not refresh the replacement's TTL",
    );
    assert.ok(snapshot(saved).mtimeMs > openedMtime);
    cache.assertClosed();
  });

  test(`artwork ${kind}: an empty observed entry must not delete its replacement`, (t) => {
    const cache = fixture(t);
    const target = cache[kind];
    put(target, "");
    const replacement =
      kind === "index"
        ? Buffer.from(otherHash)
        : Buffer.from("replacement variant");
    let replacementMtime = 0;
    const observed = afterMetadata(t, cache, target, () => {
      fs.renameSync(target, `${target}.empty`);
      put(target, replacement);
      replacementMtime = snapshot(target).mtimeMs;
    });

    assert.equal(lookupArtworkVariant(cache.url, 200), null);
    assert.equal(observed(), true);
    assert.doesNotThrow(
      () => snapshot(target),
      "an empty-entry miss must not delete its replacement",
    );
    assert.deepEqual(snapshot(target).bytes, replacement);
    assert.equal(snapshot(target).mtimeMs, replacementMtime);
    cache.assertClosed();
  });

  test(`artwork ${kind}: an expired opened entry remains a miss after replacement`, (t) => {
    const cache = fixture(t);
    const target = cache[kind];
    const content = kind === "index" ? Buffer.from(hash) : bytes;
    put(target, content, 40 * 24 * 60 * 60_000);
    let replacementMtime = 0;
    const observed = afterMetadata(t, cache, target, () => {
      fs.renameSync(target, `${target}.expired`);
      put(target, content);
      replacementMtime = snapshot(target).mtimeMs;
    });
    assert.equal(lookupArtworkVariant(cache.url, 200), null);
    assert.equal(observed(), true);
    assert.equal(snapshot(target).mtimeMs, replacementMtime);
    assert.deepEqual(snapshot(target).bytes, content);
    cache.assertClosed();
  });

  test(`artwork ${kind}: a missing entry is a miss`, (t) => {
    const cache = fixture(t);
    fs.renameSync(cache[kind], `${cache[kind]}.absent`);
    assert.equal(lookupArtworkVariant(cache.url, 200), null);
    cache.assertClosed();
  });

  for (const operation of [
    "fstatSync",
    "readFileSync",
    "futimesSync",
    "closeSync",
  ] as const) {
    test(`artwork ${kind}: ${operation} failure is a miss and releases open files`, (t) => {
      const cache = fixture(t);
      const target = cache[kind];
      const before = snapshot(target).bytes;
      let failed = false;
      const fail = () => {
        failed = true;
        throw Object.assign(new Error("fixture I/O failure"), { code: "EIO" });
      };
      if (operation === "fstatSync") {
        t.mock.method(fs, operation, (fd: number) => {
          if (cache.matches(target, fd)) fail();
          return real.fstatSync(fd);
        });
      } else if (operation === "readFileSync") {
        t.mock.method(
          fs,
          operation,
          (...args: Parameters<typeof fs.readFileSync>) => {
            if (cache.matches(target, args[0])) fail();
            return Reflect.apply(real.readFileSync, fs, args);
          },
        );
      } else if (operation === "futimesSync") {
        t.mock.method(
          fs,
          operation,
          (...args: Parameters<typeof fs.futimesSync>) => {
            if (cache.matches(target, args[0])) fail();
            return real.futimesSync(...args);
          },
        );
      } else {
        t.mock.method(fs, operation, (fd: number) => {
          real.closeSync(fd);
          if (cache.matches(target, fd)) fail();
        });
      }
      syncBuiltinESMExports();

      assert.equal(lookupArtworkVariant(cache.url, 200), null);
      assert.equal(
        failed,
        true,
        "the fixture must reach the failing operation",
      );
      assert.deepEqual(
        snapshot(target).bytes,
        before,
        "a read failure must preserve the cache entry",
      );
      cache.assertClosed();
    });
  }
}

test("artwork variant: truncation after metadata remains a zero-byte miss", (t) => {
  const cache = fixture(t);
  const observed = afterMetadata(t, cache, cache.variant, () => {
    fs.writeFileSync(cache.variant, "");
  });
  assert.equal(lookupArtworkVariant(cache.url, 200), null);
  assert.equal(observed(), true);
  assert.deepEqual(snapshot(cache.variant).bytes, Buffer.alloc(0));
  cache.assertClosed();
});

test("artwork index: a passthrough miss and unchanged remember preserve the index mtime", (t) => {
  const cache = fixture(t);
  fs.renameSync(cache.variant, `${cache.variant}.absent`);
  const before = snapshot(cache.index);
  assert.equal(lookupArtworkVariant(cache.url, 200), null);
  rememberArtworkVariant(cache.url, hash);
  assert.deepEqual(snapshot(cache.index), before);
  cache.assertClosed();
});

test("artwork index: only a trimmed lowercase SHA-256 can select a matching variant", (t) => {
  const cache = fixture(t);
  fc.assert(
    fc.property(
      fc.oneof(
        fc.stringMatching(/^[0-9a-f]{64}$/),
        fc.stringMatching(/^[0-9A-Za-z_-]{1,80}$/),
      ),
      fc.constantFrom("", " \n", "\t"),
      (candidate, whitespace) => {
        // A decoy makes malformed acceptance visible as a hit, not a second miss.
        put(cache.variantFor(candidate), bytes);
        put(cache.index, whitespace + candidate + whitespace);
        const valid =
          candidate.length === 64 &&
          [...candidate].every((char) => "0123456789abcdef".includes(char));
        const hit = lookupArtworkVariant(cache.url, 200);
        if (valid) {
          assert.equal(hit?.hash, candidate);
          assert.deepEqual(hit?.bytes, bytes);
        } else {
          assert.equal(
            hit,
            null,
            "malformed index text must not select its decoy variant",
          );
        }
        cache.assertClosed();
      },
    ),
  );
});

test("artwork cache: Windows timestamp access preserves disk hits", (t) => {
  const cache = fixture(t);
  const indexMtime = snapshot(cache.index).mtimeMs;
  const variantMtime = snapshot(cache.variant).mtimeMs;
  const readOnly = new Set<number>();
  const trackedOpen = fs.openSync;
  t.mock.method(
    fs,
    "openSync",
    (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = trackedOpen(file, flags, mode);
      if (flags === "r") readOnly.add(fd);
      else readOnly.delete(fd);
      return fd;
    },
  );
  t.mock.method(
    fs,
    "futimesSync",
    (...args: Parameters<typeof fs.futimesSync>) => {
      // Windows SetFileTime requires write access to file attributes.
      if (readOnly.has(args[0])) {
        throw Object.assign(new Error("FILE_WRITE_ATTRIBUTES required"), {
          code: "EPERM",
        });
      }
      return real.futimesSync(...args);
    },
  );
  syncBuiltinESMExports();

  const hit = lookupArtworkVariant(cache.url, 200);
  assert.equal(
    hit?.hash,
    hash,
    "a Windows timestamp update must preserve the disk hit",
  );
  assert.deepEqual(hit?.bytes, bytes);
  assert.ok(snapshot(cache.index).mtimeMs > indexMtime);
  assert.ok(snapshot(cache.variant).mtimeMs > variantMtime);
  cache.assertClosed();
});
