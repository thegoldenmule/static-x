export function scaled(value: number): number {
  return value * 2 + value * 2;
}

export function scaledOnce(): number {
  return scaled(4);
}
