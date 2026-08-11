import type { Kennel } from './kennel.js';

/**
 * Reads a member through an element type rather than off a named
 * binding, which is where the tool's cheap analysis stops and the
 * typecheck takes over.
 */
export function ratings(kennels: readonly Kennel[]): number[] {
  return kennels.map((kennel) => kennel.rating);
}
