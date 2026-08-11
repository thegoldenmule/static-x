export function countdown(n: number): number {
  return n <= 0 ? 0 : countdown(n - 1) + 100;
}

export function runCountdown(): number {
  return countdown(3);
}
