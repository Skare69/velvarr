import { test } from "node:test";
import assert from "node:assert/strict";
import {
  duplicateReport,
  mergeNotSubmitted,
} from "../src/lib/duplicate-report.ts";
import type {
  CatalogDetail,
  DuplicateMovieMatch,
} from "../src/lib/contracts.ts";

const movie: CatalogDetail = {
  reference: {
    provider: "tpdb",
    kind: "movie",
    id: "abcdefab-0000-4000-8000-000000000001",
  },
  title: "Originaltitel",
  releaseDate: "2024-01-01",
  durationSeconds: 1000,
  studio: { name: "Original studio" },
  credits: [],
  tags: [],
  related: [],
  links: [],
  aliases: [],
};
const match: DuplicateMovieMatch = {
  reference: {
    provider: "tpdb",
    kind: "movie",
    id: "abcdefab-0000-4000-8000-000000000002",
  },
  title: "English title",
  releaseDate: "2024-04-05",
  durationSeconds: 900,
  studio: "English distributor",
  tpdbUrl: "https://theporndb.net/movies/abcdefab-0000-4000-8000-000000000002",
  rules: ["hash", "metadata"],
  evidence: {
    sharedHashes: [{ type: "PHASH", hash: "abcdef0123456789" }],
    sharedPerformerIds: ["abcdefab-0000-4000-8000-000000000003"],
    tagOverlap: 0.5,
    posterDistance: 10,
  },
};

test("manual report contains both identities and the actual match evidence", () => {
  const selfUrl = `https://theporndb.net/movies/${movie.reference.id}`;
  const text = duplicateReport(movie, selfUrl, match);
  for (const value of [
    movie.title,
    match.title,
    movie.reference.id,
    match.reference.id,
    selfUrl,
    match.tpdbUrl,
    movie.releaseDate!,
    match.releaseDate!,
    movie.studio!.name,
    match.studio!,
    "PHASH",
    "abcdef0123456789",
    "50%",
    "10 of 64",
    "1000",
    "900",
    ...match.evidence.sharedPerformerIds!,
  ])
    assert.ok(text.includes(value), value);
  assert.match(text, /Possible duplicate/);
});

test("hash-only report does not invent missing metadata or poster evidence", () => {
  const hashOnly = {
    ...match,
    releaseDate: undefined,
    durationSeconds: undefined,
    studio: undefined,
    rules: ["hash"] as DuplicateMovieMatch["rules"],
    evidence: { sharedHashes: match.evidence.sharedHashes },
  };
  const text = duplicateReport(
    movie,
    `https://theporndb.net/movies/${movie.reference.id}`,
    hashOnly,
  );
  assert.ok(text.includes("not supplied"));
  assert.ok(!text.includes("undefined"));
  assert.ok(!text.includes("Poster dHash"));
  assert.ok(!text.includes("Tag overlap"));
});

test("only a proven refusal offers a merge resubmit; any other failure is unknown", () => {
  for (const code of [
    "tpdb_merge_rejected",
    "tpdb_merge_session",
    "catalog_not_found",
    "invalid_field",
    "upstream_unavailable",
    "provider_not_configured",
    "rate_limited",
  ]) {
    assert.equal(mergeNotSubmitted(code), true, code);
  }
  // A lost answer after TPDB got the form, a lost Velvarr response, or an
  // internal fault: the merge may exist, so a second press could file it twice.
  for (const code of ["tpdb_merge_unknown", "network", "internal", "error"]) {
    assert.equal(mergeNotSubmitted(code), false, code);
  }
});
