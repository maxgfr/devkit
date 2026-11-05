export type DiffLine = { kind: "same" | "add" | "del"; text: string; a?: number; b?: number };

/** Line diff by longest common subsequence (fine up to a few thousand lines). */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  if (n * m > 25_000_000) throw new Error("Texts too large to diff here");
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) out.push({ kind: "same", text: x[i]!, a: ++i, b: ++j });
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: "del", text: x[i]!, a: ++i });
    else out.push({ kind: "add", text: y[j]!, b: ++j });
  }
  while (i < n) out.push({ kind: "del", text: x[i]!, a: ++i });
  while (j < m) out.push({ kind: "add", text: y[j]!, b: ++j });
  return out;
}
