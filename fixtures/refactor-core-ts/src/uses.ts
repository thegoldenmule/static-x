import { Counter, scale } from './counter.js';

/** A destructuring READ — the case ReferenceEntry.isWriteAccess gets wrong. */
export function describe(counter: Counter): string {
  const { count } = counter;
  return `${counter.label}: ${String(count)}`;
}

/** A direct call. */
export function doubled(value: number): number {
  return scale(value, 2);
}

/** The function handed out as a value: arity moves under assignability here. */
export function scaleAll(values: number[]): number[] {
  return values.map((value) => scale(value, 3));
}

export const bound = scale.bind(null, 10);

export const escaped: ((a: number, b: number) => number)[] = [scale];
