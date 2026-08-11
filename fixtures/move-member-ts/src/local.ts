import { Pricing } from './pricing.js';

export function packingSlip(grossKg: number): string {
  const netWeight = 'net';
  return `${netWeight} ${Pricing.netWeight(grossKg)}`;
}
