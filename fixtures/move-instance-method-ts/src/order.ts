import { Invoice, Ledger } from './invoice.js';
import { pad, round2 } from './money.js';
import type { Terms } from './terms.js';

export class Order {
  private readonly channel = 'web';

  constructor(
    readonly sku: string,
    readonly quantity: number,
    readonly unitPrice: number,
  ) {}

  /** Charge this order to an invoice. */
  bill(invoice: Invoice, note: string): number {
    const amount = round2(this.quantity * this.unitPrice);
    invoice.total += amount;
    invoice.add(`${this.sku} ${note}`);
    return amount;
  }

  /** Feature envy with nothing left over: the receiver is never read. */
  stampOn(invoice: Invoice, note: string): void {
    invoice.add(`stamp ${note}`);
  }

  /** Ledger already declares `record`. */
  record(ledger: Ledger): string {
    return `${this.sku} ${ledger.record()}`;
  }

  /** Reads a private of Order, which Invoice cannot see. */
  auditTo(invoice: Invoice): string {
    return `${this.channel}:${invoice.total}`;
  }

  /** `width` is a number, not a class this tool could write to. */
  labelFor(width: number): string {
    return pad(this.sku, width);
  }

  /** Terms is an interface, and interfaces hold no implementations. */
  dueUnder(terms: Terms): number {
    return this.quantity * terms.net;
  }

  /** An overload set: three declarations, one of them the body. */
  tag(invoice: Invoice): string;
  tag(invoice: Invoice, extra: string): string;
  tag(invoice: Invoice, extra?: string): string {
    return `${invoice.total}${extra ?? ''}`;
  }

  /** Recursive, so the rewrite would have to edit the text it moves. */
  chain(invoice: Invoice, depth: number): number {
    return depth <= 0 ? invoice.total : this.chain(invoice, depth - 1);
  }

  /** Handed out as a value in report.ts, never called there. */
  summarize(invoice: Invoice): string {
    return `${this.sku}/${invoice.total}`;
  }

  /** Called on a receiver that does work. */
  charge(invoice: Invoice): number {
    return invoice.total + this.quantity;
  }

  /** The destination parameter has a default, so a call may omit it. */
  annotate(note: string, invoice: Invoice = new Invoice()): string {
    invoice.add(note);
    return `${this.sku}:${note}`;
  }

  /** The destination is the second argument, so the flip reorders. */
  transfer(note: string, invoice: Invoice): string {
    invoice.add(note);
    return `${this.sku}->${note}`;
  }

  /** Private, and reached from a public method of this same class. */
  private priceCheck(invoice: Invoice): boolean {
    return invoice.total > this.unitPrice;
  }

  /** Keeps `priceCheck` reachable from inside Order and nowhere else. */
  needsReview(invoice: Invoice): boolean {
    return this.priceCheck(invoice);
  }
}
