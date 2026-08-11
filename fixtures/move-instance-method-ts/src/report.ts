import { Invoice } from './invoice.js';
import { Order } from './order.js';

/** A second call site, inside a class, reached through a loop variable. */
export class Batch {
  constructor(private readonly orders: Order[]) {}

  total(invoice: Invoice): number {
    let sum = 0;
    for (const order of this.orders) {
      sum += order.bill(invoice, 'batch');
    }
    return sum;
  }
}

function makeOrder(): Order {
  return new Order('sku-2', 1, 5);
}

/** The receiver does work, so it cannot be evaluated second. */
export function trouble(): number {
  return makeOrder().charge(new Invoice());
}

const priced = new Order('sku-3', 1, 1);

/** The destination argument is omitted here, taking the default. */
export const annotated = priced.annotate('note');

/** Handed out as a value: its signature is checked by assignability. */
export const summarizer = new Order('sku-9', 1, 1).summarize;
