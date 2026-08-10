/** `fallback` is one of the two sites `T` is inferred from. */
export function pick<T>(items: T[], fallback: T): T {
  return items[0] ?? fallback;
}

export function pickFirst(): number {
  return pick([1, 2], 0);
}

export function pickOnly(): number {
  return pick<number>([3], 0);
}
