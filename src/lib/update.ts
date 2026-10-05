const NUMERIC = /^\d+(\.\d+)*$/;

/** True when `latest` is strictly newer than `current`; both are plain
 * MAJOR.MINOR.PATCH numbers and missing segments count as zero. Anything
 * unparsable (prerelease suffix, garbage, empty) compares false — the chip
 * never claims an update it cannot prove. */
export function isNewerVersion(latest: string, current: string): boolean {
  // Number() alone would read "", "0x1", " 1" and "1." as integers; the
  // shape guard is what makes the contract above true.
  if (!NUMERIC.test(latest) || !NUMERIC.test(current)) return false;
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
