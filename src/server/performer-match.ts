// Performer match scoring: pure comparison of the facts two providers publish
// about a person, no I/O. A score only nominates a suggestion; the user
// confirms every merge (docs/specs/performer-matches.md, "Scoring").

import type {
  CatalogDetail,
  CatalogPerson,
  CatalogProvider,
  PerformerMatchSignal,
} from "../lib/contracts.ts";
import { crossProviderLink, identityLinkKey } from "./identity-links.ts";

export const MATCH_SUGGEST_MIN = 40;
export const MATCH_MAX_SUGGESTIONS = 5;
export const MATCH_MAX_CANDIDATES = 10;

const PROVIDER_LABELS: Record<CatalogProvider, string> = {
  tpdb: "TPDB",
  stashdb: "StashDB",
};

type Accuracy = "day" | "month" | "year";
const ACCURACY_LENGTH: Record<Accuracy, number> = {
  year: 4,
  month: 7,
  day: 10,
};
const BIRTH_POINTS: Record<Accuracy, number> = { year: 10, month: 25, day: 40 };

const ETHNICITY_SYNONYMS: Record<string, string> = {
  white: "caucasian",
  ebony: "black",
  latina: "latin",
  latino: "latin",
  hispanic: "latin",
};
const STASHDB_ETHNICITIES: Record<string, true> = {
  caucasian: true,
  black: true,
  asian: true,
  indian: true,
  latin: true,
  "middle eastern": true,
  mixed: true,
  other: true,
};

/** NFKD, diacritics removed, lowercase, every run of non-alphanumerics one
 * space: "Abella  Dánger" and "abella-danger" compare equal. */
export function normalizePerformerName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Case and underscore folding for humanised enum labels. */
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_]+/g, " ")
    .trim();
}

/** The lower of the two accuracies; a missing accuracy vouches for the day. */
function sharedAccuracy(
  a: Accuracy | undefined,
  b: Accuracy | undefined,
): Accuracy {
  const order: Accuracy[] = ["year", "month", "day"];
  return order[Math.min(order.indexOf(a ?? "day"), order.indexOf(b ?? "day"))]!;
}

function dateSignal(
  key: "birthDate" | "deathDate",
  verb: string,
  a: CatalogPerson,
  b: CatalogPerson,
): PerformerMatchSignal | undefined {
  const dateA = key === "birthDate" ? a.birthDate : a.deathDate;
  const dateB = key === "birthDate" ? b.birthDate : b.deathDate;
  if (dateA === undefined || dateB === undefined) return undefined;
  const accuracy =
    key === "birthDate"
      ? sharedAccuracy(a.birthDateAccuracy, b.birthDateAccuracy)
      : sharedAccuracy(a.deathDateAccuracy, b.deathDateAccuracy);
  const left = dateA.slice(0, ACCURACY_LENGTH[accuracy]);
  const right = dateB.slice(0, ACCURACY_LENGTH[accuracy]);
  if (left === right) {
    return {
      key,
      verdict: "match",
      label: `${verb} ${left} on both`,
      points: key === "birthDate" ? BIRTH_POINTS[accuracy] : 15,
    };
  }
  return {
    key,
    verdict: "conflict",
    label: `${verb} ${left} vs ${right}`,
    points: key === "birthDate" ? -60 : -30,
  };
}

/** A match or conflict on a numeric fact: a difference up to `near`
 * matches, one above `far` conflicts, the band between says nothing. */
function rangeSignal(
  key: "height" | "careerStart",
  noun: string,
  unit: string,
  a: number | undefined,
  b: number | undefined,
  [near, far]: [number, number],
  [matchPoints, conflictPoints]: [number, number],
): PerformerMatchSignal | undefined {
  if (a === undefined || b === undefined) return undefined;
  const diff = Math.abs(a - b);
  const label =
    a === b
      ? `${noun} ${a}${unit} on both`
      : `${noun} ${a}${unit} vs ${b}${unit}`;
  if (diff <= near)
    return { key, verdict: "match", label, points: matchPoints };
  if (diff > far)
    return { key, verdict: "conflict", label, points: conflictPoints };
  return undefined;
}

function labelSignal(
  key: "gender" | "eyeColor" | "hairColor" | "ethnicity" | "cupSize",
  noun: string,
  a: string | undefined,
  b: string | undefined,
  normalize: (s: string) => string,
  points: [number, number | undefined],
  conflicts: (x: string, y: string) => boolean = () => true,
): PerformerMatchSignal | undefined {
  if (a === undefined || b === undefined) return undefined;
  const x = normalize(a);
  const y = normalize(b);
  if (x === "" || y === "") return undefined;
  if (x === y) {
    return {
      key,
      verdict: "match",
      label: `${noun} ${a} on both`,
      points: points[0],
    };
  }
  if (points[1] === undefined || !conflicts(x, y)) return undefined;
  return {
    key,
    verdict: "conflict",
    label: `${noun} ${a} vs ${b}`,
    points: points[1],
  };
}

function linkKeys(detail: CatalogDetail): Set<string> {
  const keys = new Set<string>();
  for (const link of detail.links) {
    const key = identityLinkKey(link.url);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

function nameSignal(
  subject: CatalogDetail,
  candidate: CatalogDetail,
): PerformerMatchSignal | undefined {
  const title = normalizePerformerName(subject.title);
  if (title !== "" && title === normalizePerformerName(candidate.title)) {
    return { key: "name", verdict: "match", label: "Same name", points: 25 };
  }
  const names = (d: CatalogDetail) =>
    new Set(
      [d.title, ...d.aliases]
        .map(normalizePerformerName)
        .filter((n) => n !== ""),
    );
  const mine = names(subject);
  for (const name of names(candidate)) {
    if (mine.has(name)) {
      return {
        key: "name",
        verdict: "match",
        label: "Name matches an alias",
        points: 15,
      };
    }
  }
  return undefined;
}

/** Scores how probably `candidate` (the other provider) is the same person as
 * `subject`. A signal exists only when both records publish the field: an
 * absent fact is never evidence either way. A gender conflict is a hard
 * conflict: the caller never offers that candidate. */
export function scorePerformerMatch(
  subject: CatalogDetail,
  candidate: CatalogDetail,
): {
  score: number;
  confidence: "high" | "medium" | "low";
  signals: PerformerMatchSignal[];
  hardConflict: boolean;
} {
  const signals: (PerformerMatchSignal | undefined)[] = [];
  const back = crossProviderLink(candidate).linked;
  if (
    back !== undefined &&
    back.provider === subject.reference.provider &&
    back.id === subject.reference.id.toLowerCase()
  ) {
    signals.push({
      key: "linksBack",
      verdict: "match",
      label: `The ${PROVIDER_LABELS[candidate.reference.provider]} record links to this ${PROVIDER_LABELS[subject.reference.provider]} record`,
      points: 100,
    });
  }
  const mine = linkKeys(subject);
  const shared = [...linkKeys(candidate)].filter((k) => mine.has(k));
  if (shared.length > 0) {
    signals.push({
      key: "profileLink",
      verdict: "match",
      label: `Shares ${shared.length} profile link${shared.length === 1 ? "" : "s"} (${shared.slice(0, 3).join(", ")})`,
      points: Math.min(60, 40 + 10 * (shared.length - 1)),
    });
  }
  signals.push(nameSignal(subject, candidate));
  const a: CatalogPerson = subject.person ?? {};
  const b: CatalogPerson = candidate.person ?? {};
  signals.push(
    dateSignal("birthDate", "Born", a, b),
    dateSignal("deathDate", "Died", a, b),
    labelSignal(
      "gender",
      "Gender",
      a.gender,
      b.gender,
      (s) =>
        s
          .toLowerCase()
          .replace(/transgender/g, "trans")
          .replace(/[\s_]+/g, ""),
      [5, -100],
    ),
    rangeSignal(
      "height",
      "Height",
      " cm",
      a.heightCm,
      b.heightCm,
      [3, 8],
      [10, -25],
    ),
    labelSignal(
      "eyeColor",
      "Eye color",
      a.eyeColor,
      b.eyeColor,
      fold,
      [5, -10],
    ),
    labelSignal("hairColor", "Hair color", a.hairColor, b.hairColor, fold, [
      3,
      undefined,
    ]),
    labelSignal(
      "ethnicity",
      "Ethnicity",
      a.ethnicity,
      b.ethnicity,
      (s) =>
        Object.hasOwn(ETHNICITY_SYNONYMS, fold(s))
          ? ETHNICITY_SYNONYMS[fold(s)]!
          : fold(s),
      [5, -10],
      (x, y) =>
        Object.hasOwn(STASHDB_ETHNICITIES, x) &&
        Object.hasOwn(STASHDB_ETHNICITIES, y),
    ),
    // Whole years: a difference of 5 or more is "above 4".
    rangeSignal(
      "careerStart",
      "Career start",
      "",
      a.careerStartYear,
      b.careerStartYear,
      [1, 4],
      [5, -5],
    ),
    labelSignal(
      "cupSize",
      "Cup size",
      a.cupSize,
      b.cupSize,
      (s) => s.toUpperCase().replace(/[^A-Z]/g, ""),
      [3, undefined],
    ),
  );
  const present = signals.filter(
    (s): s is PerformerMatchSignal => s !== undefined,
  );
  const total = present.reduce((sum, s) => sum + s.points, 0);
  const score = Math.min(100, Math.max(0, total));
  return {
    score,
    confidence: score >= 80 ? "high" : score >= 55 ? "medium" : "low",
    signals: present,
    hardConflict: present.some(
      (s) => s.key === "gender" && s.verdict === "conflict",
    ),
  };
}
