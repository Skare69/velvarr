import assert from "node:assert/strict";
import { test } from "node:test";
import { linkLabel } from "../src/lib/links.ts";

// Link chips must never look identical while pointing at different places,
// and a generic label must not hide which site a chip opens.

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
