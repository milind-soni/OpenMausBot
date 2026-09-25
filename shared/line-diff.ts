/** Detailed line diff for small approval cards; a complete replacement for
 * larger documents. A byte limit alone does not bound a quadratic matrix:
 * 24KB of newlines would otherwise allocate hundreds of millions of cells. */
export function lineDiff(before: string, after: string): string[] {
  if (before === after) return [];
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > 160_000) return [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)];
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`-${a[i]}`);
      i++;
    } else {
      out.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`-${a[i++]}`);
  while (j < m) out.push(`+${b[j++]}`);
  return out;
}

/** Cap on diff lines rendered inside an approval card. Past this the card
 * shows the complete proposed document instead of a truncated diff, because
 * truncation can hide the very instructions being approved. */
export const MAX_DIFF_LINES = 400;

/** The SOUL.md review block shared by the profile and team-setup cards:
 * byte counts, a line diff for reviewable changes, and the complete
 * replacement when the diff would outrun the card. The full replacement is
 * already byte-bounded by profile validation and is readable in the same
 * generic card on desktop and phones. */
export function soulDiffLines(before: string, after: string): string[] {
  const encoder = new TextEncoder();
  const bytesBefore = encoder.encode(before).length;
  const bytesAfter = encoder.encode(after).length;
  const diff = lineDiff(before, after);
  if (diff.length > MAX_DIFF_LINES) {
    return [
      `SOUL.md (${bytesBefore} → ${bytesAfter} bytes):`,
      "Large change — complete proposed instructions (replaces the current SOUL.md):",
      after || "(empty)",
    ];
  }
  return [`SOUL.md (${bytesBefore} → ${bytesAfter} bytes):`, ...diff];
}
