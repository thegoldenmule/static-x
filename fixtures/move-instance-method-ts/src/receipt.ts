import { round2 } from './money.js';
import { Printer } from './printer.js';

export class Receipt {
  readonly printer: Printer;

  private readonly stamp = new Printer('* ');

  constructor(
    readonly id: string,
    readonly amount: number,
  ) {
    this.printer = new Printer('# ');
  }

  /** Formats through the printer it holds — feature envy on Printer. */
  render(width: number): string {
    return this.printer.wrap(`${this.id} ${round2(this.amount)}`).padEnd(width);
  }

  /** The field it envies is private, so no call site could reach it. */
  emboss(): string {
    return this.stamp.wrap(this.id);
  }
}
