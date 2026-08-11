import { bump, cost } from './counter.js';

/** Pure and read once: the ordinary case. */
export function area(w: number): number {
  const doubled = w * 2;
  return doubled + 1;
}

/** Effectful, read once, nothing evaluated in between. */
export function nextValue(): number {
  const next = bump();
  return next + 1;
}

/** Effectful and read twice: inlining would call bump() twice. */
export function pair(): number {
  const both = bump();
  return both + both;
}

/** Effectful, read once, but only on one branch. */
export function firstTick(flag: boolean): number {
  const tick = bump();
  return flag ? tick : 0;
}

/** Effectful, read once, with another call evaluated before the read. */
export function ordered(): number {
  const first = bump();
  return cost() + first;
}

/** Allocates: two reads would be two distinct objects. */
export function twiceListed(): object[] {
  const row = { id: 1 };
  return [row, row];
}

/** Reassigned, so its reads are not all its initializer. */
export function grow(): number {
  let size = 1;
  size += 1;
  return size + size;
}

/** Destructured: the binding is not one initializer expression. */
export function firstWidth(box: { width: number }): number {
  const { width: only } = box;
  return only;
}

/** Reads a `let` that is assigned before the read: 7 today, 15 inlined. */
export function drifting(): number {
  let base = 1;
  const scaled = base * 2;
  base = 5;
  return scaled + base;
}

/** Read as a shorthand property, where the initializer cannot go bare. */
export function boxed(w: number): Record<string, number> {
  const doubledW = w * 2;
  return { doubledW };
}

/** One of two declarators, so only its own share of the line goes. */
export function pairSum(): number {
  const one = 1,
    other = 2;
  return one + other;
}

/** A loop binding, which exists only for one turn of the loop. */
export function total(xs: number[]): number {
  let sum = 0;
  for (const each of xs) sum += each;
  return sum;
}
