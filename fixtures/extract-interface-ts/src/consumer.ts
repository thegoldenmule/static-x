import { Kennel } from './kennel.js';

export function summarize(kennel: Kennel): string {
  return `${kennel.name}: ${String(kennel.vacancies)} free`;
}

export function fill(kennel: Kennel, dogs: readonly string[]): number {
  let run = 0;
  for (const dog of dogs) run = kennel.book(dog);
  return run;
}

/** Still constructs the class directly, so this file stays coupled to it. */
export const flagship: Kennel = new Kennel('flagship');
