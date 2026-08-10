// A .spec.ts file, excluded by default exactly like .test.ts. Its body
// is an exact copy of gamma.ts's scoreAlerts, so with includeTests the
// gamma group grows to three members and scoreAlerts flips to exact.
export function scoreAlertsSpec(entries: number[]): number {
  let total = 0;
  let count = 0;
  for (const entry of entries) {
    const weighted = entry * 3;
    if (weighted > 10) {
      total = total + weighted;
      count = count + 1;
    }
  }
  return total * count;
}
