export const SCALE = 10;

export function boost(n: number): number {
  return n * SCALE;
}

export function boosted(): number {
  const SCALE = 2;
  return boost(SCALE);
}
