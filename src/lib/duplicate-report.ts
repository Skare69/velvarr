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
