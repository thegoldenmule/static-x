import { Invoice } from './invoice.js';

export class Draft {
  stamp(): string {
    return 'draft';
  }

  /** Quote overrides this, so the two declarations are one member. */
  settle(invoice: Invoice): number {
    return invoice.total;
  }
}

export class Quote extends Draft {
  constructor(private readonly discount: number) {
    super();
  }

  /** Reads `super`, which does not travel with the method. */
  attach(invoice: Invoice): string {
    return `${super.stamp()} ${invoice.total}`;
  }

  override settle(invoice: Invoice): number {
    return invoice.total - this.discount;
  }
}
