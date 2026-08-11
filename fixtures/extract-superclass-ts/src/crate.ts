import { CRATE_LIMIT } from './holding.js';
import type { Tag } from './shapes.js';

/** A crate of tagged things. */
export class Crate<T extends Tag> {
  items: T[] = [];

  /** Adds one, returning the new size. */
  add(item: T): number {
    if (this.items.length >= CRATE_LIMIT) throw new Error('crate is full');
    this.items.push(item);
    return this.items.length;
  }

  get first(): T | undefined {
    return this.items[0];
  }

  set first(value: T | undefined) {
    if (value) this.items[0] = value;
  }

  labels(): string {
    return this.items.map((item) => item.label).join(',');
  }
}
