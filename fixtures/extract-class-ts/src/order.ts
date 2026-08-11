import { round, type Money } from './money.js';

interface Line {
  sku: string;
  qty: number;
  unit: Money;
}

/**
 * An order that grew a second responsibility: it holds the lines, and
 * it also knows how the totals are adjusted.
 */
export class Order {
  readonly id: string;
  private readonly lines: Line[] = [];

  /** Percentage taken off the subtotal. */
  discountRate = 0;

  /** Percentage added after the discount. */
  taxRate = 0;

  constructor(id: string) {
    this.id = id;
  }

  /** Builds an empty order. Static, so it is move-member's business. */
  static open(id: string): Order {
    return new Order(id);
  }

  add(sku: string, qty: number, unit: Money): void {
    this.lines.push({ sku, qty, unit });
  }

  subtotal(): Money {
    return this.lines.reduce((sum, line) => sum + line.qty * line.unit, 0);
  }

  /** The amount the discount rate takes off `amount`. */
  discountFor(amount: Money): Money {
    return round((amount * this.discountRate) / 100);
  }

  /** The tax the tax rate adds to `amount`. */
  taxFor(amount: Money): Money {
    return round((amount * this.taxRate) / 100);
  }

  total(): Money {
    const net = this.subtotal() - this.discountFor(this.subtotal());
    return net + this.taxFor(net);
  }
}
