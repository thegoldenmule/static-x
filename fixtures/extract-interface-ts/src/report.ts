import type { Kennel } from './kennel.js';

export function report(kennel: Kennel): string {
  const { name, occupancy } = kennel;
  return `${name} has ${String(occupancy)} dogs`;
}
