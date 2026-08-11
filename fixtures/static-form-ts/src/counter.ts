export class Counter {
  /** Never written, and its initializer is a constant. */
  readonly limit = 100;

  /** Written per instance: one shared slot would be a different program. */
  seen = 0;

  /** One evaluation per instance today, one for the whole program if static. */
  startedAt = Date.now();

  /** Already static, and with no parameter that could become a receiver. */
  static readonly ceiling = 1000;

  bump(): void {
    this.seen += 1;
  }

  room(): number {
    return this.limit - this.seen;
  }
}
