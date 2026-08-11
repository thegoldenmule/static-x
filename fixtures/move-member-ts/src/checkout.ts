import { Pricing } from './pricing.js';

export function checkout(weightKg: number, currency: string): string {
  return `${Pricing.label(currency)} ${Pricing.shipping(weightKg)}`;
}
