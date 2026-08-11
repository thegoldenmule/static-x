import { Pricing } from './pricing.js';

export class Discounted extends Pricing {}

export function inheritedLabel(): string {
  return Discounted.label('USD');
}
