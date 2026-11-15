import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { REDACTED, SECRET_PIECE_MIN, redactSecret } from "../src/lib/redact.ts";

// A key in the shape hosted chat servers issue: a public prefix, then
// random characters. FAKE: no real key looks like this.
const KEY = "sk-proj-FAKEtest4321";

test("the whole key goes, and the server's own words stay", () => {
  assert.equal(
    redactSecret(
      `Incorrect API key provided: Bearer ${KEY}. Check the key.`,
      KEY,
    ),
    `Incorrect API key provided: Bearer ${REDACTED}. Check the key.`,
  );
});

test("every repeat goes, and repeats that touch read as one", () => {
  assert.equal(
    redactSecret(`${KEY} and ${KEY}`, KEY),
    `${REDACTED} and ${REDACTED}`,
  );
  assert.equal(redactSecret(`${KEY}${KEY}`, KEY), REDACTED);
  // Two pieces from different parts of the key, back to back.
  assert.equal(
    redactSecret(`[${KEY.slice(8)}${KEY.slice(0, 10)}]`, KEY),
    `[${REDACTED}]`,
  );
});

test("a piece of eight characters goes, a piece of seven stays", () => {
  assert.equal(
    redactSecret(`it starts with ${KEY.slice(8, 16)}`, KEY),
    `it starts with ${REDACTED}`,
  );
  assert.equal(
    redactSecret(`it starts with ${KEY.slice(8, 15)}`, KEY),
    `it starts with ${KEY.slice(8, 15)}`,
  );
});

test("a masked echo loses its long prefix and keeps its short tail", () => {
  assert.equal(
    redactSecret("Incorrect API key provided: sk-proj-********4321.", KEY),
    `Incorrect API key provided: ${REDACTED}********4321.`,
  );
});

test("a key shorter than eight characters goes only whole", () => {
  assert.equal(
    redactSecret("bad key lm-key, not lm-ke", "lm-key"),
    `bad key ${REDACTED}, not lm-ke`,
  );
});

test("without a stored key the text stays as it is", () => {
  assert.equal(redactSecret(`Bearer ${KEY}`, undefined), `Bearer ${KEY}`);
  assert.equal(redactSecret(`Bearer ${KEY}`, ""), `Bearer ${KEY}`);
});

// Brute force over every substring: a character is hidden when it lies in
// a piece of the secret of at least SECRET_PIECE_MIN characters (the whole
// secret when it is shorter); each run of hidden characters reads as one
// REDACTED.
function bruteForce(text: string, secret: string): string {
  const min = Math.min(SECRET_PIECE_MIN, secret.length);
  const hidden = new Array<boolean>(text.length).fill(false);
  for (let start = 0; start < text.length; start++) {
    for (let end = start + min; end <= text.length; end++) {
      if (secret.includes(text.slice(start, end)))
        hidden.fill(true, start, end);
    }
  }
  let out = "";
  for (let k = 0; k < text.length; k++) {
    if (!hidden[k]) out += text[k];
    else if (k === 0 || !hidden[k - 1]) out += REDACTED;
  }
  return out;
}

test("property: redaction agrees with a brute-force search of every substring", () => {
  // Three letters make partial, overlapping and repeated pieces common. The
  // text holds two cut copies of the secret between random fillers.
  const filler = fc.stringMatching(/^[ab-]{0,12}$/);
  fc.assert(
    fc.property(
      fc.stringMatching(/^[ab-]{1,20}$/),
      fc.tuple(filler, filler, filler),
      fc.tuple(fc.nat(), fc.nat(), fc.nat(), fc.nat()),
      (secret, [left, middle, right], [a, b, c, d]) => {
        const cut = (x: number, y: number) => {
          const i = x % (secret.length + 1);
          const j = y % (secret.length + 1);
          return secret.slice(Math.min(i, j), Math.max(i, j));
        };
        const text = left + cut(a, b) + middle + cut(c, d) + right;
        assert.equal(redactSecret(text, secret), bruteForce(text, secret));
      },
    ),
  );
});
