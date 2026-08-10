export class Counter {
  /** Assigned once, by the constructor: readonly is safe. */
  limit: number;
  /** Read by destructuring in consumer.ts, where isWriteAccess lies. */
  label: string;
  /** No annotation: `number` only because a mutable property widens. */
  count = 0;
  /** A method and another file both write this one. */
  total = 0;
  /** A #private field is a property with a modifier, like any other. */
  #tag: string;

  constructor(limit: number, start: number) {
    this.limit = limit;
    this.label = `counter(${limit})`;
    this.count = start;
    this.#tag = `counter-${limit}`;
  }

  bump(amount: number): void {
    this.total += amount;
  }

  remaining(): number {
    return this.limit - this.count;
  }

  get tag(): string {
    return this.#tag;
  }
}
