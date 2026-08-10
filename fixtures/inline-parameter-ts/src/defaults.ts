export function format(a: string, b = 5, c?: number): string {
  return `${a}/${b}/${c ?? 0}`;
}

/** Omits `b` entirely, so the value it passes is the default. */
export function short(): string {
  return format('x');
}

/** Writes `b` out, plus a trailing argument for `c`. */
export function long(): string {
  return format('x', 5, 9);
}
