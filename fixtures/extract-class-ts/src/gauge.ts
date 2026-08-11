/** A class whose movable member is a get/set pair over a #private field. */
export class Gauge {
  #level = 0;

  /** Reading, as a percentage. */
  get level(): number {
    return this.#level;
  }

  set level(value: number) {
    this.#level = Math.max(0, Math.min(100, value));
  }

  /** Stays behind, and reads the pair through `this`. */
  label(): string {
    return `${this.level}%`;
  }
}
