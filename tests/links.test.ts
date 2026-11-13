import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import "./setup.ts";
import { linkLabel } from "../src/lib/links.ts";

// Link chips must never look identical while pointing at different places,
// and a generic label must not hide which site a chip opens. StashDB links
// are user-submitted, so a chip text must also survive a malformed
// percent-escape ("%zz", "%E0%A4%A") instead of throwing URIError in render.

const links = [
  { label: "Studio profile", url: "https://www.elegantangel.com/707810/x" },
  { label: "Studio profile", url: "https://hollyrandall.com/models/J.html" },
  { label: "OnlyFans", url: "https://onlyfans.com/freejewelzblu" },
  { label: "OnlyFans", url: "https://onlyfans.com/jewelzblu" },
  { label: "IAFD", url: "https://www.iafd.com/person.rme/id=1" },
];

test("a generic studio label shows the site instead", () => {
  assert.equal(linkLabel(links[0]!, links, "TPDB"), "elegantangel.com");
  const alone = [links[0]!];
  assert.equal(linkLabel(alone[0]!, alone, "TPDB"), "elegantangel.com");
});

test("two accounts on one site show the account", () => {
  assert.equal(
    linkLabel(links[2]!, links, "TPDB"),
    "onlyfans.com/freejewelzblu",
  );
  assert.equal(linkLabel(links[3]!, links, "TPDB"), "onlyfans.com/jewelzblu");
});

test("a unique, specific label stays as published", () => {
  assert.equal(linkLabel(links[4]!, links, "TPDB"), "IAFD");
});

test("a link without a label falls back to the provider name", () => {
  const l = { url: "https://stashdb.org/performers/1" };
  assert.equal(linkLabel(l, [l], "StashDB"), "StashDB");
});

// Counterexample from the field: one stray "%" in a user-submitted handle
// used to throw URIError out of linkLabel and crash the performer page.
test("a malformed percent-escape keeps the label a string", () => {
  const links = [
    { label: "OnlyFans", url: "https://onlyfans.com/freejewelzblu" },
    { label: "OnlyFans", url: "https://onlyfans.com/%zz" },
  ];
  assert.equal(linkLabel(links[1]!, links, "TPDB"), "onlyfans.com/%zz");
  assert.equal(
    linkLabel(links[0]!, links, "TPDB"),
    "onlyfans.com/freejewelzblu",
  );
});

// For any URL the URL parser accepts, linkLabel renders a non-empty string
// and never throws: a bad escape degrades to the raw segment, a chip never
// crashes the page. Each link gets a same-label, same-host sibling so the
// handle path (the one that decodes) runs on every iteration.
const escapeSegment = fc.oneof(
  fc.constant("%zz"),
  fc.constant("%E0%A4%A"),
  fc.constant("%"),
  fc.constant("%2F"),
  fc.constant("100%real"),
  fc.stringMatching(/^[a-zA-Z0-9%._~-]{1,12}$/),
);
const linkArb = fc.record({
  label: fc.option(fc.constantFrom("OnlyFans", "Studio profile", "IAFD"), {
    nil: undefined,
  }),
  // A fixed ".com" tail: a host ending in digits would parse as IPv4
  // and leave the property's domain ("new URL accepts it") by accident.
  host: fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/),
  seg: fc.option(escapeSegment, { nil: undefined }),
});

test("linkLabel renders a non-empty string for every parseable URL", () => {
  fc.assert(
    fc.property(
      fc.array(linkArb, { minLength: 1, maxLength: 3 }),
      (records) => {
        const all = records.map((r) => ({
          label: r.label,
          url: `https://www.${r.host}.com/${r.seg ?? ""}`,
        }));
        for (const { label, host, seg } of records) {
          const link = { label, url: `https://www.${host}.com/${seg ?? ""}` };
          assert.ok(new URL(link.url)); // by construction: within the property's domain
          const sibling = { label, url: `https://www.${host}.com/other` };
          for (const l of [link, sibling]) {
            const text = linkLabel(l, [l, sibling, ...all], "TPDB"); // must not throw
            assert.equal(typeof text, "string");
            assert.ok(text.length > 0);
          }
        }
      },
    ),
  );
});
