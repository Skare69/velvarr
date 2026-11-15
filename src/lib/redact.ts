// Removes a stored secret from text that another party wrote. A server can
// repeat the Authorization value in its own words: whole, cut short, or
// masked around a piece of it. Every run of the secret that is long enough
// to help guess it goes. Pure, no IO.

/** The shortest piece of a secret that redaction removes. A shorter piece
 * gives too little of a key to use. A secret shorter than this is removed
 * only whole. */
export const SECRET_PIECE_MIN = 8;

/** What a removed run reads as. */
export const REDACTED = "[redacted]";

/** The [start, end) spans of `text` that are the secret or a piece of it of
 * at least SECRET_PIECE_MIN characters (the whole secret when it is
 * shorter), merged where they overlap or touch. For each end position, the
 * longest piece of the secret that ends there: O(text × secret) time, two
 * rows of memory. */
export function secretSpans(text: string, secret: string): [number, number][] {
  const min = Math.min(SECRET_PIECE_MIN, secret.length);
  const spans: [number, number][] = [];
  if (min === 0) return spans;
  // row[j + 1]: the length of the common run that ends at text[i] and at
  // secret[j]. Index 0 stays 0 in both rows.
  let prev = new Uint32Array(secret.length + 1);
  let row = new Uint32Array(secret.length + 1);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let longest = 0;
    for (let j = 0; j < secret.length; j++) {
      const run = c === secret.charCodeAt(j) ? prev[j]! + 1 : 0;
      row[j + 1] = run;
      if (run > longest) longest = run;
    }
    if (longest >= min) {
      const start = i + 1 - longest;
      const last = spans.at(-1);
      // A run that ends later never starts earlier (the longest run grows
      // by at most one per character), so extending the last span merges
      // every overlap and every repeat that touches it.
      if (last !== undefined && start <= last[1]) last[1] = i + 1;
      else spans.push([start, i + 1]);
    }
    [prev, row] = [row, prev];
  }
  return spans;
}

/** `text` with every span of the secret replaced by REDACTED. Unchanged
 * when no secret is stored. */
export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret) return text;
  let out = "";
  let at = 0;
  for (const [start, end] of secretSpans(text, secret)) {
    out += text.slice(at, start) + REDACTED;
    at = end;
  }
  return out + text.slice(at);
}
