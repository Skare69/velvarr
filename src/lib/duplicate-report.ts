import type { CatalogDetail, DuplicateMovieMatch } from "./contracts.ts";

export function duplicateReport(
  movie: CatalogDetail,
  selfUrl: string,
  match: DuplicateMovieMatch,
): string {
  const lines = [
    "Possible duplicate TPDB movies — please review both records.",
    "",
    `Original record: ${movie.title}`,
    `TPDB id: ${movie.reference.id}`,
    `URL: ${selfUrl}`,
    `Release date: ${movie.releaseDate ?? "not supplied"}`,
    `Duration (seconds): ${movie.durationSeconds ?? "not supplied"}`,
    `Studio: ${movie.studio?.name ?? "not supplied"}`,
    "",
    `Other record: ${match.title}`,
    `TPDB id: ${match.reference.id}`,
    `URL: ${match.tpdbUrl}`,
    `Release date: ${match.releaseDate ?? "not supplied"}`,
    `Duration (seconds): ${match.durationSeconds ?? "not supplied"}`,
    `Studio: ${match.studio ?? "not supplied"}`,
    "",
    `Matched rules: ${match.rules.join(", ")}`,
  ];
  for (const h of match.evidence.sharedHashes ?? []) {
    lines.push(`Shared ${h.type}: ${h.hash}`);
  }
  if (match.evidence.sharedPerformerIds) {
    lines.push(
      `Shared TPDB performer ids: ${match.evidence.sharedPerformerIds.join(", ")}`,
    );
  }
  if (match.evidence.tagOverlap !== undefined) {
    lines.push(
      `Tag overlap against the smaller set: ${Math.round(match.evidence.tagOverlap * 100)}%`,
    );
  }
  if (match.evidence.posterDistance !== undefined) {
    lines.push(
      `Poster dHash distance: ${match.evidence.posterDistance} of 64 bits`,
    );
  }
  return lines.join("\n");
}

const RULE_WORDS: Record<DuplicateMovieMatch["rules"][number], string> = {
  hash: "shared file hash",
  metadata: "metadata match (cast, year, tags and poster)",
};

/** Error codes of a merge submit that prove TPDB stored nothing: Velvarr
 * refused the request, failed before it posted TPDB's form, or TPDB
 * refused the form. Any other failure (`tpdb_merge_unknown`, a lost
 * Velvarr response, an internal error) leaves the outcome unknown, so the
 * UI must not offer a resubmit that could file a second merge. */
export function mergeNotSubmitted(code: string): boolean {
  return (
    code.startsWith("invalid_") ||
    code.startsWith("upstream_") ||
    [
      "tpdb_merge_rejected",
      "tpdb_merge_session",
      "catalog_not_found",
      "provider_not_configured",
      "payload_too_large",
      "rate_limited",
      "forbidden",
      "unauthenticated",
      "session_revoked",
    ].includes(code)
  );
}

/** Default notes for TPDB's merge form, which asks where the information
 * comes from. The viewed record (`movie`) merges into `match`. */
export function mergeNotes(
  movie: CatalogDetail,
  match: DuplicateMovieMatch,
): string {
  const lines = [
    `Duplicate of ${match.title} (${match.tpdbUrl}).`,
    `This record: ${movie.title} (TPDB id ${movie.reference.id})`,
    `Source site: ${movie.studio?.name ?? "not supplied"}`,
    `Matched rules: ${match.rules.map((rule) => RULE_WORDS[rule]).join(", ")}`,
  ];
  for (const h of match.evidence.sharedHashes ?? []) {
    lines.push(`Shared ${h.type}: ${h.hash}`);
  }
  lines.push("Submitted via Velvarr's duplicate check.");
  return lines.join("\n");
}
