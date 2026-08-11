/** No named function encloses the arrow, so there is no signature to change. */
export const handlers: Array<(value: number) => number> = [
  (value) => value * 7,
];

/** The expression sits in the parameter list, not the body. */
export function padTo(width: number = 4 * 2): string {
  return '='.repeat(width);
}
