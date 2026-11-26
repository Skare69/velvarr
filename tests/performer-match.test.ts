import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type {
  CatalogDetail,
  CatalogPerson,
  ExternalLink,
  PerformerMatchSignal,
} from "../src/lib/contracts.ts";
import { scorePerformerMatch } from "../src/server/performer-match.ts";

// The scorer behind performer match suggestions
// (docs/specs/performer-matches.md, "Scoring"). The subject is always the
// opened TPDB record and the candidate a StashDB search hit, unless a test
// swaps them on purpose. Points come from the spec table, so the tests pin
// them exactly.

const SUBJECT_ID = "2a2b3c4d-0000-4000-8000-00000000aa01";
const CANDIDATE_ID = "4c4d5e6f-0000-4000-8000-00000000bb01";

function performer(
  provider: "tpdb" | "stashdb",
  title: string,
  person?: CatalogPerson,
  over: { aliases?: string[]; links?: ExternalLink[] } = {},
): CatalogDetail {
  return {
    reference: {
      provider,
      kind: "performer",
      id: provider === "tpdb" ? SUBJECT_ID : CANDIDATE_ID,
    },
    title,
    credits: [],
    tags: [],
    related: [],
    links: over.links ?? [],
    aliases: over.aliases ?? [],
    ...(person !== undefined ? { person } : {}),
  };
}
const subject = (
  title: string,
  person?: CatalogPerson,
  over?: { aliases?: string[]; links?: ExternalLink[] },
) => performer("tpdb", title, person, over);
const candidate = (
  title: string,
  person?: CatalogPerson,
  over?: { aliases?: string[]; links?: ExternalLink[] },
) => performer("stashdb", title, person, over);

/** [key, verdict, points] per signal, sorted by key: order is not the
 * contract, the evidence is. */
const evidence = (signals: PerformerMatchSignal[]) =>
  signals
    .map((s) => [s.key, s.verdict, s.points] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
const signalOf = (
  signals: PerformerMatchSignal[],
  key: PerformerMatchSignal["key"],
) => signals.find((s) => s.key === key);

const born = (
  birthDate: string,
  birthDateAccuracy?: "day" | "month" | "year",
): CatalogPerson => ({
  birthDate,
  ...(birthDateAccuracy !== undefined ? { birthDateAccuracy } : {}),
});

test("same name, same day birth date and same gender score medium with three match signals", () => {
  const facts: CatalogPerson = {
    gender: "Female",
    birthDate: "1990-05-04",
    birthDateAccuracy: "day",
  };
  const r = scorePerformerMatch(
    subject("Jane Doe", facts),
    candidate("Jane Doe", facts),
  );
  assert.equal(r.score, 70);
  assert.ok(r.score >= 55);
  assert.equal(r.confidence, "medium");
  assert.equal(r.hardConflict, false);
  assert.deepEqual(evidence(r.signals), [
    ["birthDate", "match", 40],
    ["gender", "match", 5],
    ["name", "match", 25],
  ]);
  // Every signal carries a plain-English label for the page.
  for (const s of r.signals) assert.ok(s.label.trim().length > 0);
});

test("names compare after NFKD, diacritic, case and separator normalization", () => {
  const r = scorePerformerMatch(subject("Jané  Doe"), candidate("jane-doe"));
  assert.deepEqual(evidence(r.signals), [["name", "match", 25]]);
  assert.equal(r.score, 25);
});

test("a name that only matches an alias scores 15, in both directions", () => {
  const viaCandidateAlias = scorePerformerMatch(
    subject("Jane Doe"),
    candidate("Janie D", undefined, { aliases: ["Jane Doe"] }),
  );
  assert.deepEqual(evidence(viaCandidateAlias.signals), [
    ["name", "match", 15],
  ]);
  const viaSubjectAlias = scorePerformerMatch(
    subject("Janie D", undefined, { aliases: ["JANE DOE"] }),
    candidate("Jane Doe"),
  );
  assert.deepEqual(evidence(viaSubjectAlias.signals), [["name", "match", 15]]);
  // Different names with no shared alias are no evidence at all.
  const unrelated = scorePerformerMatch(
    subject("Jane Doe", undefined, { aliases: ["JD"] }),
    candidate("Mary Major", undefined, { aliases: ["MM"] }),
  );
  assert.equal(signalOf(unrelated.signals, "name"), undefined);
  assert.equal(unrelated.score, 0);
});

test("birth dates compare at the lower of the two precisions", () => {
  const birthPoints = (a: CatalogPerson, b: CatalogPerson) =>
    signalOf(
      scorePerformerMatch(subject("A", a), candidate("B", b)).signals,
      "birthDate",
    );
  // Year precision on one side: only the year is compared.
  assert.deepEqual(
    pick(birthPoints(born("1990-05-04", "day"), born("1990-01-01", "year"))),
    ["match", 10],
  );
  // Month precision: year and month are compared.
  assert.deepEqual(
    pick(birthPoints(born("1990-05-04", "day"), born("1990-05-01", "month"))),
    ["match", 25],
  );
  // Day on both sides.
  assert.deepEqual(
    pick(birthPoints(born("1990-05-04", "day"), born("1990-05-04", "day"))),
    ["match", 40],
  );
  // A missing accuracy counts as day, so a different day is a conflict.
  assert.deepEqual(
    pick(birthPoints(born("1990-05-04"), born("1990-05-05", "day"))),
    ["conflict", -60],
  );
  // A different year at year precision is a conflict too.
  assert.deepEqual(
    pick(birthPoints(born("1990-05-04", "day"), born("1991-01-01", "year"))),
    ["conflict", -60],
  );
  // A different month hidden by year precision is not a conflict.
  assert.deepEqual(
    pick(birthPoints(born("1990-12-31", "year"), born("1990-05-04", "day"))),
    ["match", 10],
  );
});

function pick(s: PerformerMatchSignal | undefined) {
  assert.ok(s, "expected a birthDate signal");
  return [s.verdict, s.points];
}

test("a birth-date conflict makes a same-named record unsuggestable", () => {
  const r = scorePerformerMatch(
    subject("Jane Doe", { gender: "Female", ...born("1990-05-04", "day") }),
    candidate("Jane Doe", { gender: "Female", ...born("1985-02-03", "day") }),
  );
  // 25 + 5 - 60 clamps to 0: below the suggestion floor of 40.
  assert.equal(r.score, 0);
  assert.ok(r.score < 40);
  assert.equal(r.hardConflict, false);
  assert.deepEqual(pick(signalOf(r.signals, "birthDate")), ["conflict", -60]);
});

test("a gender conflict is a hard conflict", () => {
  const r = scorePerformerMatch(
    subject("Jane Doe", { gender: "Female", ...born("1990-05-04", "day") }),
    candidate("Jane Doe", { gender: "Male", ...born("1990-05-04", "day") }),
  );
  assert.equal(r.hardConflict, true);
  const gender = signalOf(r.signals, "gender");
  assert.equal(gender?.verdict, "conflict");
  assert.equal(gender?.points, -100);
});

test("gender normalization equates the TPDB and StashDB spellings", () => {
  for (const [a, b] of [
    ["Transgender Female", "Trans Female"],
    ["Trans_Female", "Transgender female"],
    ["female", "Female"],
  ] as const) {
    const r = scorePerformerMatch(
      subject("A", { gender: a }),
      candidate("B", { gender: b }),
    );
    assert.equal(r.hardConflict, false, `${a} vs ${b}`);
    assert.deepEqual(evidence(r.signals), [["gender", "match", 5]]);
  }
  // Trans and cis female stay different people.
  const r = scorePerformerMatch(
    subject("A", { gender: "Transgender Female" }),
    candidate("B", { gender: "Female" }),
  );
  assert.equal(r.hardConflict, true);
});

test("a candidate that links back to the subject scores 100 and clamps", () => {
  const r = scorePerformerMatch(
    subject("Jane Doe"),
    candidate("Jane Doe", undefined, {
      links: [{ url: `https://theporndb.net/performers/${SUBJECT_ID}` }],
    }),
  );
  assert.deepEqual(evidence(r.signals), [
    ["linksBack", "match", 100],
    ["name", "match", 25],
  ]);
  assert.equal(r.score, 100);
  assert.equal(r.confidence, "high");
  // A provider link to a different TPDB record is not a link back.
  const other = scorePerformerMatch(
    subject("Jane Doe"),
    candidate("Jane Doe", undefined, {
      links: [
        {
          url: "https://theporndb.net/performers/2a2b3c4d-0000-4000-8000-00000000ffff",
        },
      ],
    }),
  );
  assert.equal(signalOf(other.signals, "linksBack"), undefined);
  assert.equal(other.score, 25);
});

test("shared profile links add 40 plus 10 per extra key, capped at 60", () => {
  const handles = ["instagram.com", "twitter.com", "onlyfans.com", "x.com"];
  // The subject publishes www/trailing-slash/upper-case forms; the
  // candidate the plain forms. Both collapse to the same identity keys.
  const mine = handles.map((h) => ({ url: `https://www.${h}/SomeOne/` }));
  const theirs = handles.map((h) => ({ url: `https://${h}/someone` }));
  const expected = [40, 50, 60, 60];
  for (let n = 1; n <= handles.length; n++) {
    const r = scorePerformerMatch(
      subject("Jane Doe", undefined, { links: mine.slice(0, n) }),
      candidate("Mary Major", undefined, { links: theirs.slice(0, n) }),
    );
    assert.deepEqual(evidence(r.signals), [
      ["profileLink", "match", expected[n - 1]!],
    ]);
    assert.equal(r.score, expected[n - 1]);
  }
  // Links that are not identity pages never count.
  const content = scorePerformerMatch(
    subject("Jane Doe", undefined, {
      links: [{ url: "https://www.instagram.com/p/abc123" }],
    }),
    candidate("Mary Major", undefined, {
      links: [{ url: "https://instagram.com/p/abc123" }],
    }),
  );
  assert.deepEqual(content.signals, []);
});

test("absent fields on either side produce no signal", () => {
  const full: CatalogPerson = {
    gender: "Female",
    birthDate: "1990-05-04",
    birthDateAccuracy: "day",
    deathDate: "2020-01-01",
    deathDateAccuracy: "day",
    heightCm: 168,
    eyeColor: "Brown",
    hairColor: "Black",
    ethnicity: "Caucasian",
    careerStartYear: 2010,
    cupSize: "34D",
  };
  for (const other of [undefined, {}, { country: "US" }] as const) {
    const forward = scorePerformerMatch(
      subject("Jane Doe", full),
      candidate("Mary Major", other),
    );
    assert.deepEqual(forward.signals, []);
    assert.equal(forward.score, 0);
    assert.equal(forward.hardConflict, false);
    const reverse = scorePerformerMatch(
      subject("Jane Doe", other),
      candidate("Mary Major", full),
    );
    assert.deepEqual(reverse.signals, []);
  }
});

test("ethnicity compares through synonyms and conflicts only inside the StashDB set", () => {
  const eth = (a: string, b: string) =>
    scorePerformerMatch(
      subject("A", { ethnicity: a }),
      candidate("B", { ethnicity: b }),
    );
  assert.deepEqual(evidence(eth("White", "Caucasian").signals), [
    ["ethnicity", "match", 5],
  ]);
  assert.deepEqual(evidence(eth("Latina", "Hispanic").signals), [
    ["ethnicity", "match", 5],
  ]);
  assert.deepEqual(evidence(eth("Ebony", "Black").signals), [
    ["ethnicity", "match", 5],
  ]);
  assert.deepEqual(evidence(eth("Asian", "Black").signals), [
    ["ethnicity", "conflict", -10],
  ]);
  // A vocabulary outside the StashDB set is never a conflict.
  const unknown = eth("Mediterranean", "Caucasian");
  assert.equal(
    unknown.signals.some((s) => s.verdict === "conflict"),
    false,
  );
  assert.equal(unknown.score, 0);
});

test("cup sizes compare the letters only", () => {
  const r = scorePerformerMatch(
    subject("A", { cupSize: "34D" }),
    candidate("B", { cupSize: "D" }),
  );
  assert.deepEqual(evidence(r.signals), [["cupSize", "match", 3]]);
  const different = scorePerformerMatch(
    subject("A", { cupSize: "34D" }),
    candidate("B", { cupSize: "32C" }),
  );
  assert.equal(
    different.signals.some((s) => s.key === "cupSize" && s.points !== 0),
    false,
  );
});

test("height, eye colour, career start and death date follow their bands", () => {
  const one = (a: CatalogPerson, b: CatalogPerson) =>
    evidence(scorePerformerMatch(subject("A", a), candidate("B", b)).signals);
  assert.deepEqual(one({ heightCm: 168 }, { heightCm: 171 }), [
    ["height", "match", 10],
  ]);
  assert.deepEqual(one({ heightCm: 168 }, { heightCm: 177 }), [
    ["height", "conflict", -25],
  ]);
  // Between 4 and 8 cm apart is neither evidence nor conflict.
  assert.deepEqual(
    one({ heightCm: 168 }, { heightCm: 174 }).filter(([, , p]) => p !== 0),
    [],
  );
  assert.deepEqual(one({ eyeColor: "Brown" }, { eyeColor: "Brown" }), [
    ["eyeColor", "match", 5],
  ]);
  assert.deepEqual(one({ eyeColor: "Brown" }, { eyeColor: "Blue" }), [
    ["eyeColor", "conflict", -10],
  ]);
  // Hair is dyed: a different colour is never a conflict.
  assert.deepEqual(
    one({ hairColor: "Black" }, { hairColor: "Blonde" }).filter(
      ([, v]) => v === "conflict",
    ),
    [],
  );
  assert.deepEqual(one({ careerStartYear: 2010 }, { careerStartYear: 2011 }), [
    ["careerStart", "match", 5],
  ]);
  assert.deepEqual(one({ careerStartYear: 2010 }, { careerStartYear: 2015 }), [
    ["careerStart", "conflict", -5],
  ]);
  assert.deepEqual(
    one(
      { deathDate: "2020-03-01", deathDateAccuracy: "month" },
      { deathDate: "2020-03-17", deathDateAccuracy: "day" },
    ),
    [["deathDate", "match", 15]],
  );
  assert.deepEqual(
    one(
      { deathDate: "2020-03-01", deathDateAccuracy: "day" },
      { deathDate: "2021-03-01", deathDateAccuracy: "day" },
    ),
    [["deathDate", "conflict", -30]],
  );
});

test("confidence bands: high from 80, medium from 55, low below", () => {
  const day = born("1990-05-04", "day");
  const month = born("1990-05-04", "month");
  const cases: [CatalogPerson, CatalogPerson, number, string][] = [
    // name 25 + birth day 40 + height 10 + gender 5
    [
      { ...day, heightCm: 168, gender: "Female" },
      { ...day, heightCm: 170, gender: "Female" },
      80,
      "high",
    ],
    // name 25 + birth day 40 + gender 5 + eyes 5 + hair 3
    [
      { ...day, gender: "Female", eyeColor: "Brown", hairColor: "Black" },
      { ...day, gender: "Female", eyeColor: "Brown", hairColor: "Black" },
      78,
      "medium",
    ],
    // name 25 + birth month 25 + gender 5
    [
      { ...month, gender: "Female" },
      { ...day, gender: "Female" },
      55,
      "medium",
    ],
    // name 25 + birth month 25 + hair 3
    [
      { ...month, hairColor: "Black" },
      { ...day, hairColor: "Black" },
      53,
      "low",
    ],
  ];
  for (const [a, b, score, confidence] of cases) {
    const r = scorePerformerMatch(
      subject("Jane Doe", a),
      candidate("Jane Doe", b),
    );
    assert.equal(r.score, score);
    assert.equal(r.confidence, confidence, `score ${score}`);
  }
});

// Facts from small vocabularies so matches and conflicts both occur often.
// No arbitrary link points at a provider record, so `linksBack` never fires.
const dateArb = fc
  .tuple(
    fc.constantFrom("1989", "1990"),
    fc.constantFrom("01", "05"),
    fc.constantFrom("01", "04"),
  )
  .map(([y, m, d]) => `${y}-${m}-${d}`);
const accuracyArb = fc.constantFrom("day", "month", "year");
const personArb: fc.Arbitrary<CatalogPerson> = fc.record(
  {
    gender: fc.constantFrom(
      "Female",
      "Male",
      "Transgender Female",
      "Trans Female",
    ),
    birthDate: dateArb,
    birthDateAccuracy: accuracyArb,
    deathDate: dateArb,
    deathDateAccuracy: accuracyArb,
    heightCm: fc.integer({ min: 150, max: 190 }),
    eyeColor: fc.constantFrom("Brown", "Blue"),
    hairColor: fc.constantFrom("Black", "Blonde"),
    ethnicity: fc.constantFrom(
      "White",
      "Caucasian",
      "Asian",
      "Black",
      "Latina",
      "Mediterranean",
    ),
    careerStartYear: fc.integer({ min: 2000, max: 2012 }),
    cupSize: fc.constantFrom("34D", "D", "C"),
  },
  { requiredKeys: [] },
);
const nameArb = fc.constantFrom("Jane Doe", "jane-doe", "Janet Roe", "JD");
const linkArb = fc.subarray(
  [
    "https://www.instagram.com/someone/",
    "https://instagram.com/someone",
    "https://twitter.com/someone",
    "https://x.com/other",
    "https://onlyfans.com/someone",
    "https://example.com/someone",
  ],
  { maxLength: 4 },
);
const sideArb = fc.record({
  title: nameArb,
  aliases: fc.subarray(["Jane Doe", "Janet Roe", "JD"], { maxLength: 2 }),
  links: linkArb,
  person: fc.option(personArb, { nil: undefined }),
});

test("property: the score stays in 0..100, matches its band, and ignores direction", () => {
  // Seed and run count come from tests/setup.ts (seed 42, 200 runs).
  fc.assert(
    fc.property(sideArb, sideArb, (a, b) => {
      const s = subject(a.title, a.person, {
        aliases: a.aliases,
        links: a.links.map((url) => ({ url })),
      });
      const c = candidate(b.title, b.person, {
        aliases: b.aliases,
        links: b.links.map((url) => ({ url })),
      });
      const forward = scorePerformerMatch(s, c);
      assert.ok(Number.isInteger(forward.score));
      assert.ok(forward.score >= 0 && forward.score <= 100);
      assert.equal(
        forward.confidence,
        forward.score >= 80 ? "high" : forward.score >= 55 ? "medium" : "low",
      );
      assert.equal(
        forward.hardConflict,
        forward.signals.some(
          (x) => x.key === "gender" && x.verdict === "conflict",
        ),
      );
      // Without a link back every rule is symmetric: swapping the sides
      // keeps the score and the hard-conflict verdict.
      const reverse = scorePerformerMatch(c, s);
      assert.equal(reverse.score, forward.score);
      assert.equal(reverse.hardConflict, forward.hardConflict);
    }),
  );
});
