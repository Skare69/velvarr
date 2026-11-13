// test:mutation:delta - mutate only the files changed since the last tag.
// Review and release cards run this instead of the full gate: same config
// and suites, but the mutant set is the working-tree diff against the
// newest reachable tag, intersected with stryker.config.mjs's mutate
// globs. The run is a review instrument, not a merge bar: it reports the
// diff's score and prints every survivor, and it does not enforce break,
// because a release diff can carry the known accepted survivors
// (browse.ts, related.ts) that only the full gate's whole denominator
// prices in. No changed file under the globs means nothing to run.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "../stryker.config.mjs";

function git(args) {
  return spawnSync("git", args, { encoding: "utf8" });
}

const described = git(["describe", "--tags", "--abbrev=0"]);
if (described.status !== 0) {
  console.error(
    "test:mutation:delta: git describe found no tag:",
    described.stderr.trim(),
  );
  process.exit(1);
}
const tag = described.stdout.trim();

const diff = git(["diff", "--name-only", tag]);
if (diff.status !== 0) {
  console.error("test:mutation:delta: git diff failed:", diff.stderr.trim());
  process.exit(1);
}
const changed = diff.stdout.split("\n").filter((name) => name !== "");

// One glob segment at a time: `**/` matches zero or more directories, `*`
// stays inside one segment, `?` is one non-separator character. A leading
// `!` excludes, like Stryker's own mutate list does.
function globToRegExp(glob) {
  let negated = false;
  let pattern = glob;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:[^/]*/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
    }
  }
  return { negated, regexp: new RegExp(`^${out}$`) };
}

const positives = [];
const negatives = [];
for (const glob of config.mutate) {
  const rule = globToRegExp(glob);
  if (rule.negated) negatives.push(rule);
  else positives.push(rule);
}
const matches = (name) =>
  positives.some((r) => r.regexp.test(name)) &&
  !negatives.some((r) => r.regexp.test(name));

// A renamed or deleted path can still appear in the diff; only existing
// files can carry mutants.
const targets = changed.filter((name) => matches(name) && existsSync(name));

if (targets.length === 0) {
  console.log(
    `test:mutation:delta: no file changed since ${tag} is under the mutate globs; nothing to run.`,
  );
  process.exit(0);
}

// Stryker reads every mutate entry as a glob, and git paths can contain
// glob metacharacters: the [...path] route segment is a character class to
// the matcher (it matches one character from {., p, a, t, h}), so the raw
// path would select no file and the run would report a score over a
// smaller mutant set than the diff asked for. Replace the brackets with
// ?, which matches one character. A leading ! would flip an entry into an
// exclusion, so a file with such a name fails the run instead.
function toStrykerPattern(target) {
  if (target.startsWith("!")) {
    console.error(
      `test:mutation:delta: ${target} starts with "!", which Stryker reads as an exclusion; mutate it by hand.`,
    );
    process.exit(1);
  }
  return target.replace(/[[\]]/g, "?");
}

const patterns = targets.map(toStrykerPattern);

// Each pattern must still match the file it was derived from. A pattern
// that matches nothing would silently shrink the mutant set.
const unmatched = patterns.filter(
  (pattern, i) => !globToRegExp(pattern).regexp.test(targets[i]),
);
if (unmatched.length > 0) {
  console.error(
    "test:mutation:delta: a mutate pattern does not match its file; fix the pattern before running:",
  );
  for (const pattern of unmatched) console.error(`  ${pattern}`);
  process.exit(1);
}

console.log(
  `test:mutation:delta: ${targets.length} file(s) changed since ${tag} are under the mutate globs:`,
);
for (const name of targets) console.log(`  ${name}`);

// A generated config file carries the patterns and the report-only
// thresholds; it imports the repo config, so the runner options stay
// single-sourced.
const deltaConfigPath = join(
  tmpdir(),
  `velvarr-stryker-delta-${process.pid}.mjs`,
);
const repoConfigUrl = new URL("../stryker.config.mjs", import.meta.url);
writeFileSync(
  deltaConfigPath,
  `import base from "${repoConfigUrl.href}";
const deltaConfig = {
  ...base,
  mutate: ${JSON.stringify(patterns)},
  thresholds: { ...base.thresholds, break: null },
};
export default deltaConfig;
`,
);
try {
  const run = spawnSync("stryker", ["run", deltaConfigPath], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(deltaConfigPath, { force: true });
}
