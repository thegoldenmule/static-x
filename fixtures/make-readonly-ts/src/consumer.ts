import { Basket } from './basket.js';
import { Counter } from './counter.js';

export function summarize(counter: Counter): string {
  // A destructuring read: ReferenceEntry.isWriteAccess reports true here.
  const { label } = counter;
  return `${label}: ${counter.remaining()} left of ${counter.limit}`;
}

export function reset(counter: Counter): void {
  counter.total = 0;
}

export function fill(basket: Basket, items: string[]): void {
  for (const item of items) basket.add(item);
}
