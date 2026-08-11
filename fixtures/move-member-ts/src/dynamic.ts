import { Pricing } from './pricing.js';

export function dynamicSku(): string {
  return Pricing['sku']();
}
