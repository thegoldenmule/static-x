export class Meter {
  private _level = 0;

  #unit: string;

  constructor(unit: string) {
    this.#unit = unit;
  }

  /** Current level, in whatever unit this meter reads. */
  get level(): number {
    return this._level;
  }

  set level(next: number) {
    this._level = next;
  }

  get unit(): string {
    return this.#unit;
  }

  reset(): void {
    this._level = 0;
  }

  describe(): string {
    return `${this.#unit}:${this._level}`;
  }
}
