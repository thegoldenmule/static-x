// Exact duplicate of alpha.ts's normalizeScores: same body tokens,
// different formatting, so only token normalization matches them.
export function normalizeRatings(values: number[]): number[] {
  const result: number[] = [];
  let total = 0;

  for (const value of values) {
    total += value;
  }

  if (total === 0) {
    return values;
  }

  for (const value of values) {
    result.push(value / total);
  }

  return result;
}
