import { round2 } from './money.js';
import type { Parcel } from './types.js';

export class Pricing {
  static readonly TAX_RATE = 0.2;

  constructor(readonly currency: string) {}

  /** Freight cost for a parcel, rounded to the cent. */
  static shipping(weightKg: number): number {
    return round2(weightKg * 1.5);
  }

  static volumetric(parcel: Parcel): number {
    return round2(parcel.weightKg * 2);
  }

  static label(currency: string): string {
    return `${currency} price`;
  }

  static sku(): string {
    return 'SKU';
  }

  static netWeight(grossKg: number): number {
    return round2(grossKg - 0.4);
  }

  static tax(amount: number): number {
    return round2(amount * Pricing.TAX_RATE);
  }

  private static internalRate(): number {
    return 0.5;
  }

  static blended(amount: number): number {
    return round2(amount * Pricing.internalRate());
  }

  static describe(): string {
    return `${this.name} pricing`;
  }

  format(amount: number): string {
    return `${this.currency}${amount.toFixed(2)}`;
  }
}
