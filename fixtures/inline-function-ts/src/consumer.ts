import { difference, twice, shout, negate } from './math.js';

/** The precedence case: c - (a - b), never c - a - b. */
export function gap(c: number): number {
  return c - difference(10, 4);
}

export function label(word: string): string {
  return `<${shout(word)}>`;
}

let counter = 0;
function bump(): number {
  counter += 1;
  return counter;
}

export function doubledBump(): number {
  return twice(bump());
}

export function flipped(n: number): number {
  return negate(n);
}
