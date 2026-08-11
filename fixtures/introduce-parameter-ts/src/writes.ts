const counts = { total: 0 };

export function tally(items: string[]): number {
  counts.total = items.length;
  return counts.total + 1;
}

export function tallied(): number {
  return tally(['a']);
}
