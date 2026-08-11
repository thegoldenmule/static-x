import { featured, Shelter } from './shelter.js';

/** Reaches `star` and `featured` from another file, which is why the widening is project-wide. */
export function report(shelter: Shelter): string {
  return `${shelter.star.name} and ${featured.name}`;
}

/** Nothing is wider than `unknown`. */
export function describe(value: unknown): string {
  return typeof value;
}
