import type { Money } from './money.js';
import { Order } from './order.js';

/** Writes a moved field from outside and reads a total back. */
export function discounted(order: Order): Money {
  order.discountRate = 10;
  return order.total();
}

/** Calls a moved method through an instance rather than through `this`. */
export function preview(order: Order, amount: Money): Money {
  return order.discountFor(amount);
}
