import { SCALED } from './config.js';

/** Declares its own FACTOR, so the initializer would silently rebind. */
export function local(): number {
  const FACTOR = 100;
  return SCALED + FACTOR;
}
