import { Pricing } from './pricing.js';

export function manifestLine(weightKg: number): string {
  return `freight ${Pricing.shipping(weightKg)}`;
}
