export const BASE = 10;

export class Layout {
  /** Millimetres of padding on every side. */
  readonly padding = 10 - 4;

  /** Reads a module-level constant the other module cannot see. */
  readonly outer = BASE - 4;

  readonly rows = 3;

  private readonly seed = 7;

  static readonly VERSION = 2;

  span(count: number): number {
    return count * this.rows;
  }

  jitter(): number {
    return this.seed;
  }
}
