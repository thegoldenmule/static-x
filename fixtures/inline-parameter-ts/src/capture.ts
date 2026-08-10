import { scale } from './scaled.js';

/** Local to this module; scaled.ts cannot see it. */
const FACTOR = 3;

export function doubled(n: number): number {
  return scale(n, FACTOR);
}

export function tripled(n: number): number {
  return scale(n * 2, FACTOR);
}
