/**
 * Minimal line-based diff — `describe_brief_proposal` (DL1 — temp/briefs/
 * dl-delegation-brief.md "Interface contract") needs "a unified diff of
 * current brief vs proposed" for the UI to render line by line: `-` lines
 * struck/red, `+` lines green, everything else plain.
 *
 * No external dependency and no hunk headers (`---`/`+++`/`@@`): the
 * renderer only ever distinguishes a leading `-`, a leading `+`, or neither,
 * so headers would just be extra lines with nothing to do. A plain
 * (unchanged) line is emitted byte-for-byte, with no prefix at all — never
 * even a leading space — so it round-trips exactly as typed.
 */

/** Longest common subsequence of two line arrays, then walk it to emit `-`/`+`/plain lines. */
export function unifiedLineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of the LCS of a[i..] and b[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`-${a[i]}`);
      i++;
    } else {
      lines.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) {
    lines.push(`-${a[i]}`);
    i++;
  }
  while (j < m) {
    lines.push(`+${b[j]}`);
    j++;
  }
  return lines.join('\n');
}
