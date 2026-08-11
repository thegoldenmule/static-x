/** An overload set: several parameter lists over one implementation. */
export function widen(value: string): string;
export function widen(value: number): string;
export function widen(value: string | number): string {
  return String(value).padStart(8);
}

export function widened(): string {
  return widen('a');
}
