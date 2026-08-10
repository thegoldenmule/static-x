export function difference(a: number, b: number): number {
  return a - b;
}

/** Reads its parameter twice, so an impure argument cannot be inlined. */
export function twice(value: number): number {
  return value + value;
}

/** Depends on a module-local constant that other files cannot see. */
const SCALE = 3;
export function scaled(value: number): number {
  return value * SCALE;
}

export function shout(word: string): string {
  return word.toUpperCase();
}

/** Two statements: not a single expression. */
export function complex(a: number): number {
  const doubled = a * 2;
  return doubled + 1;
}
