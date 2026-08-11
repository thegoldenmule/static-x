import { Printer } from './printer.js';

export class Shipment {
  constructor(
    readonly tracking: string,
    readonly printer: Printer,
  ) {}

  /** The destination field is declared as a constructor parameter. */
  slip(): string {
    return this.printer.wrap(this.tracking);
  }
}

export function slipFor(shipment: Shipment): string {
  return shipment.slip();
}
