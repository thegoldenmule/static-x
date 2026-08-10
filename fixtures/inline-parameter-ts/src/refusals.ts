/** An overload set: several parameter lists over one implementation. */
export function widen(value: string, pad: number): string;
export function widen(value: number, pad: number): string;
export function widen(value: string | number, pad: number): string {
  return `${value}`.padStart(pad);
}

export function widened(): string {
  return widen('a', 4);
}

/** Reads the real argument list, which this refactoring shortens. */
export function counted(label: string, width: number): number {
  return arguments.length + width + label.length;
}

export function counting(): number {
  return counted('x', 2);
}

export function spread(a: string, b: number): string {
  return `${a}${b}`;
}

const argv: [string, number] = ['x', 1];

export function spreadCall(): string {
  return spread(...argv);
}

/** A concise body has no statement list to bind a const into. */
export const concise = (a: string, b: string): string => `${a}${b}`;

export function concisely(): string {
  return concise('x', 'y');
}
