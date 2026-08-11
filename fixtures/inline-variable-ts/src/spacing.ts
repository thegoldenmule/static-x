import * as units from './units.js';

/** Read through a namespace object, by name: `units.STEP`, not `units[k]`. */
export function gap(n: number): number {
  return n * units.STEP;
}
