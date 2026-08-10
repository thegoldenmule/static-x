export function normalizeScores(values: number[]): number[] {
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
