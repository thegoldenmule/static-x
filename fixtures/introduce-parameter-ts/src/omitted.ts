export function box(text: string, width?: number): string {
  return '['.concat(text.padEnd(width ?? 0), ']');
}

/** Omits `width`, so there is no slot to insert a third argument into. */
export function boxed(): string {
  return box('x');
}
