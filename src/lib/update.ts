/** True when `latest` is strictly newer than `current`; both are plain
 * MAJOR.MINOR.PATCH numbers and missing segments count as zero. Anything
 * unparsable (prerelease suffix, garbage, empty) compares false — the chip
 * never claims an update it cannot prove. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  if (!a.every(Number.isInteger) || !b.every(Number.isInteger)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
