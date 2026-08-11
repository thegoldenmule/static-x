export function scaleAll(values: number[]): number[] {
  return values.map((value) => value * 10);
}

export function scaledPair(): number[] {
  return scaleAll([1, 2]);
}
