// A structural-but-renamed pair: identical AST shape, different
// identifiers and literals, so the bodies match structurally only.
export function scoreAlerts(entries: number[]): number {
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

export function ratePackets(samples: number[]): number {
  let sum = 0;
  let seen = 0;
  for (const sample of samples) {
    const scaled = sample * 7;
    if (scaled > 2) {
      sum = sum + scaled;
      seen = seen + 1;
    }
  }
  return sum * seen;
}
