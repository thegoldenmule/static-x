import { scaled } from './math.js';

/** Declares its own SCALE, so the body would silently rebind. */
export function local(): number {
  const SCALE = 100;
  return scaled(2) + SCALE;
}
