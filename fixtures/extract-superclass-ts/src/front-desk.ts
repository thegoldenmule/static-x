import { Kennel } from './kennel.js';

/**
 * Nothing in this file changes when members move up: inheritance keeps
 * every call site resolving to the same thing.
 */
export function checkIn(kennel: Kennel, dog: string): number {
  kennel.book(dog);
  return kennel.admit();
}

export function occupancyOf(kennel: Kennel): number {
  return kennel.occupancy;
}
