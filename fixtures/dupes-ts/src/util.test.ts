// An exact duplicated pair inside a test file: skipped by default,
// flagged only with includeTests true.
export function buildFixture(count: number): string[] {
  const items: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const label = 'item-' + String(i);
    if (label.length > 0) {
      items.push(label);
    }
  }
  return items;
}

export function buildSample(count: number): string[] {
  const items: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const label = 'item-' + String(i);
    if (label.length > 0) {
      items.push(label);
    }
  }
  return items;
}
