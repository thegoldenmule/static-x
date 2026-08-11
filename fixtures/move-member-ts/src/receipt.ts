import { Invoice } from './invoice.js';
import { Pricing } from './pricing.js';

export function receipt(weightKg: number): string {
  return [
    Invoice.header(),
    Pricing.shipping(weightKg),
    Pricing.TAX_RATE,
    Invoice.footer(),
  ].join(' ');
}
