import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseProseDraft,
  PROSE_DRAFT_SCHEMA,
  type ProseDraft,
} from "../src/lib/prose-draft.ts";
import { SORT_KEYS } from "../src/lib/sorts.ts";

// A draft that uses every field, so a rule that drops or rewrites any field
// fails the round trip.
const full = (): ProseDraft => ({
  type: { value: "scene", source: "scenes" },
  titleWords: { value: "office party", source: "office party" },
  include: [
    {
      alternatives: [
        { value: "blonde", source: "blonde" },
        { value: "redhead", source: "redhead" },
      ],
    },
  ],
  exclude: [{ value: "anal", source: "no anal" }],
  performers: {
    mode: "any",
    names: [{ value: "Riley Reid", source: "Riley Reid" }],
  },
  studios: {
    names: [{ value: "Vixen", source: "Vixen" }],
    withChildren: { source: "its sub-studios" },
  },
  followedPerformers: { source: "performers I follow" },
  year: { from: 2015, to: 2019, source: "2015 to 2019" },
  date: { operation: ">=", date: "2020-01-01", source: "since 2020-01-01" },
  sort: { key: "recency", direction: "desc", source: "newest first" },
  skipped: [{ text: "in 4K", reason: "not_a_filter" }],
});

const empty = (): ProseDraft => ({
  type: null,
  titleWords: null,
  include: [],
  exclude: [],
  performers: { mode: "all", names: [] },
  studios: { names: [], withChildren: null },
  followedPerformers: null,
  year: null,
  date: null,
  sort: null,
  skipped: [],
});

// JSON copy, so a mutation can never reach the fixture or the expectation.
const clone = (draft: ProseDraft): Record<string, any> =>
  JSON.parse(JSON.stringify(draft)) as Record<string, any>;

const cited = (value: string) => ({ value, source: value });

test("parseProseDraft accepts a full draft and returns the same values", () => {
  const result = parseProseDraft(clone(full()));
  assert.deepEqual(result, { ok: true, draft: full() });
});

test("parseProseDraft accepts a draft with every optional value null and every list empty", () => {
  const result = parseProseDraft(clone(empty()));
  assert.deepEqual(result, { ok: true, draft: empty() });
});

test("parseProseDraft accepts the boundaries: 10 items, 10 alternatives, 300-char strings, empty strings, any integer year", () => {
  const d = clone(empty());
  d.exclude = Array.from({ length: 10 }, (_, i) => cited(`word${i}`));
  d.include = [
    {
      alternatives: Array.from({ length: 10 }, (_, i) => cited(`alt${i}`)),
    },
  ];
  d.titleWords = { value: "x".repeat(300), source: "" };
  // Range is the map's job, not the parser's.
  d.year = { from: 1800, to: 2300, source: "" };
  // Format and calendar are the map's job too.
  d.date = { operation: "=", date: "not a date", source: "" };
  const result = parseProseDraft(d);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.draft, d);
});

const rejected: [string, (d: Record<string, any>) => unknown][] = [
  ["an extra root key", (d) => ({ ...d, extra: true })],
  [
    "an extra key in a cited value",
    (d) => {
      d.include[0].alternatives[0].confidence = 1;
      return d;
    },
  ],
  [
    "an extra key in the year",
    (d) => {
      d.year.step = 1;
      return d;
    },
  ],
  [
    "a missing root key",
    (d) => {
      delete d.skipped;
      return d;
    },
  ],
  [
    "a missing nested key",
    (d) => {
      delete d.year.source;
      return d;
    },
  ],
  [
    "a missing withChildren key",
    (d) => {
      delete d.studios.withChildren;
      return d;
    },
  ],
  [
    "a number where a string belongs",
    (d) => {
      d.titleWords.value = 5;
      return d;
    },
  ],
  [
    "a bare string where a cited value belongs",
    (d) => {
      d.type = "scene";
      return d;
    },
  ],
  [
    "an object where a list belongs",
    (d) => {
      d.exclude = { value: "anal", source: "anal" };
      return d;
    },
  ],
  [
    "a type outside movie/scene/all",
    (d) => {
      d.type.value = "film";
      return d;
    },
  ],
  [
    "a performer mode outside all/any",
    (d) => {
      d.performers.mode = "both";
      return d;
    },
  ],
  [
    "a sort key outside SORT_KEYS",
    (d) => {
      d.sort.key = "rating";
      return d;
    },
  ],
  [
    "a sort direction outside asc/desc/null",
    (d) => {
      d.sort.direction = "up";
      return d;
    },
  ],
  [
    "a date operation outside the five",
    (d) => {
      d.date.operation = "!=";
      return d;
    },
  ],
  [
    "a skipped reason outside not_a_filter/unclear",
    (d) => {
      d.skipped[0].reason = "other";
      return d;
    },
  ],
  [
    "an exclude list of 11 items",
    (d) => {
      d.exclude = Array.from({ length: 11 }, (_, i) => cited(`w${i}`));
      return d;
    },
  ],
  [
    "an include list of 11 terms",
    (d) => {
      d.include = Array.from({ length: 11 }, (_, i) => ({
        alternatives: [cited(`w${i}`)],
      }));
      return d;
    },
  ],
  [
    "a performer list of 11 names",
    (d) => {
      d.performers.names = Array.from({ length: 11 }, (_, i) => cited(`p${i}`));
      return d;
    },
  ],
  [
    "a skipped list of 11 items",
    (d) => {
      d.skipped = Array.from({ length: 11 }, (_, i) => ({
        text: `s${i}`,
        reason: "unclear",
      }));
      return d;
    },
  ],
  [
    "an alternatives list of 0",
    (d) => {
      d.include = [{ alternatives: [] }];
      return d;
    },
  ],
  [
    "an alternatives list of 11",
    (d) => {
      d.include = [
        { alternatives: Array.from({ length: 11 }, (_, i) => cited(`a${i}`)) },
      ];
      return d;
    },
  ],
  [
    "a 301-char source",
    (d) => {
      d.titleWords.source = "x".repeat(301);
      return d;
    },
  ],
  [
    "a 301-char skipped text",
    (d) => {
      d.skipped[0].text = "x".repeat(301);
      return d;
    },
  ],
  [
    "a 301-char performer name",
    (d) => {
      d.performers.names[0].value = "x".repeat(301);
      return d;
    },
  ],
  [
    "a non-integer year",
    (d) => {
      d.year.from = 2019.5;
      return d;
    },
  ],
  [
    "a year as a string",
    (d) => {
      d.year.to = "2019";
      return d;
    },
  ],
  [
    "a date as a number",
    (d) => {
      d.date.date = 20200101;
      return d;
    },
  ],
];

for (const [name, mutate] of rejected) {
  test(`parseProseDraft rejects ${name}`, () => {
    const result = parseProseDraft(mutate(clone(full())));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(typeof result.reason, "string");
      assert.ok(result.reason.length > 0);
    }
  });
}

test("parseProseDraft rejects values that are not a draft object", () => {
  for (const input of [null, undefined, [], "draft", 42, true]) {
    assert.equal(parseProseDraft(input).ok, false, String(input));
  }
});

// --- PROSE_DRAFT_SCHEMA: OpenAI strict-mode shape ---

type SchemaNode = Record<string, unknown>;

const isNode = (v: unknown): v is SchemaNode =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const types = (node: SchemaNode): unknown[] =>
  Array.isArray(node.type) ? node.type : [node.type];

/** The object branch of a nullable `anyOf: [{type: "null"}, {...}]` node. */
function objectBranch(node: unknown): SchemaNode {
  assert.ok(isNode(node));
  if (types(node).includes("object")) return node;
  assert.ok(Array.isArray(node.anyOf), "expected an anyOf node");
  const branch = (node.anyOf as unknown[]).find(
    (b) => isNode(b) && types(b).includes("object"),
  );
  assert.ok(isNode(branch));
  return branch;
}

/** Every schema node under (and including) `node`, with its path. Walks
 * `properties` maps by value, so a property named like a keyword is never
 * read as one. */
function schemaNodes(node: unknown, path = "$"): [string, SchemaNode][] {
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => schemaNodes(item, `${path}[${i}]`));
  }
  if (!isNode(node)) return [];
  const out: [string, SchemaNode][] = [[path, node]];
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && isNode(value)) {
      for (const [prop, schema] of Object.entries(value)) {
        out.push(...schemaNodes(schema, `${path}.properties.${prop}`));
      }
    } else if (key === "items" || key === "anyOf") {
      out.push(...schemaNodes(value, `${path}.${key}`));
    }
  }
  return out;
}

test("PROSE_DRAFT_SCHEMA root is an object with exactly the draft's fields", () => {
  assert.equal(PROSE_DRAFT_SCHEMA.type, "object");
  const properties = PROSE_DRAFT_SCHEMA.properties;
  assert.ok(isNode(properties));
  assert.deepEqual(Object.keys(properties).sort(), Object.keys(full()).sort());
});

test("PROSE_DRAFT_SCHEMA: every object closes its keys and requires all of them", () => {
  const objects = schemaNodes(PROSE_DRAFT_SCHEMA).filter(
    ([, node]) => types(node).includes("object") || "properties" in node,
  );
  assert.ok(objects.length > 10, "expected the nested objects to be walked");
  for (const [path, node] of objects) {
    assert.ok(types(node).includes("object"), `${path} has properties`);
    assert.equal(node.additionalProperties, false, path);
    const properties = node.properties;
    assert.ok(isNode(properties), `${path}.properties`);
    assert.ok(Array.isArray(node.required), `${path}.required`);
    assert.deepEqual(
      [...(node.required as string[])].sort(),
      Object.keys(properties).sort(),
      path,
    );
  }
});

test("PROSE_DRAFT_SCHEMA holds no $ref or $defs anywhere", () => {
  const text = JSON.stringify(PROSE_DRAFT_SCHEMA);
  assert.ok(!text.includes('"$ref"'), "no $ref");
  assert.ok(!text.includes('"$defs"'), "no $defs");
  assert.ok(!text.includes('"definitions"'), "no definitions");
});

// Anthropic's structured outputs answer HTTP 400 for maxItems, minimum and
// maximum, so the schema leaves those limits to parseProseDraft (pinned above)
// and the mapper. minItems 1 on alternatives is accepted and stays.
test("PROSE_DRAFT_SCHEMA uses no keyword that Anthropic rejects", () => {
  const nodes = schemaNodes(PROSE_DRAFT_SCHEMA);
  for (const [path, node] of nodes) {
    for (const key of [
      "maxItems",
      "minimum",
      "maximum",
      "minLength",
      "maxLength",
    ])
      assert.ok(!(key in node), `${path}.${key}`);
    if ("minItems" in node) assert.ok(node.minItems === 1, path);
  }
  const root = PROSE_DRAFT_SCHEMA.properties as Record<string, SchemaNode>;
  const term = objectBranch(root.include?.items);
  const alternatives = (term.properties as Record<string, SchemaNode>)
    .alternatives;
  assert.ok(alternatives);
  assert.equal(alternatives.minItems, 1);
});

test("PROSE_DRAFT_SCHEMA enums match the draft vocabulary", () => {
  const root = PROSE_DRAFT_SCHEMA.properties as Record<string, SchemaNode>;
  const prop = (node: SchemaNode, key: string): SchemaNode => {
    const value = (node.properties as Record<string, unknown>)[key];
    assert.ok(isNode(value), key);
    return value;
  };
  const enumOf = (node: SchemaNode): unknown[] => {
    if (Array.isArray(node.enum)) return node.enum;
    const branch = (node.anyOf as unknown[] | undefined)?.find(
      (b) => isNode(b) && Array.isArray(b.enum),
    );
    assert.ok(isNode(branch), "expected an enum");
    return branch.enum as unknown[];
  };
  const sort = objectBranch(root.sort);
  assert.deepEqual(
    [...enumOf(prop(sort, "key"))].sort(),
    [...SORT_KEYS].sort(),
  );
  assert.deepEqual([...enumOf(prop(sort, "direction"))].sort(), [
    "asc",
    "desc",
  ]);
  assert.deepEqual([...enumOf(prop(objectBranch(root.type), "value"))].sort(), [
    "all",
    "movie",
    "scene",
  ]);
  assert.deepEqual(
    [...enumOf(prop(objectBranch(root.performers), "mode"))].sort(),
    ["all", "any"],
  );
  assert.deepEqual(
    [...enumOf(prop(objectBranch(root.date), "operation"))].sort(),
    ["<", "<=", "=", ">", ">="].sort(),
  );
  const skippedItem = objectBranch(root.skipped?.items);
  assert.deepEqual([...enumOf(prop(skippedItem, "reason"))].sort(), [
    "not_a_filter",
    "unclear",
  ]);
  const year = objectBranch(root.year);
  // The year range is the mapper's job (CATALOG_YEAR_MIN/MAX): Anthropic
  // rejects minimum/maximum in the schema.
  for (const bound of ["from", "to"])
    assert.equal(prop(year, bound).type, "integer", bound);
  assert.equal(
    prop(objectBranch(root.date), "date").pattern,
    "^\\d{4}-\\d{2}-\\d{2}$",
  );
});

test("PROSE_DRAFT_SCHEMA optional values are nullable, lists and groups are not", () => {
  const root = PROSE_DRAFT_SCHEMA.properties as Record<string, SchemaNode>;
  const nullable = (node: SchemaNode | undefined) =>
    Array.isArray(node?.anyOf) &&
    (node.anyOf as unknown[]).some((b) => isNode(b) && b.type === "null");
  for (const key of [
    "type",
    "titleWords",
    "followedPerformers",
    "year",
    "date",
    "sort",
  ]) {
    assert.ok(nullable(root[key]), `${key} is nullable`);
  }
  for (const key of [
    "include",
    "exclude",
    "performers",
    "studios",
    "skipped",
  ]) {
    assert.ok(!nullable(root[key]), `${key} is required, never null`);
  }
});
