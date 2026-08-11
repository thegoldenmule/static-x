/** Column layout for the printed ledger. */
export class Formatter {
  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  /** Right-pads a cell to `width` columns. Touches no instance state. */
  pad(value: string, width: number): string {
    return value.length >= width ? value : value + ' '.repeat(width - value.length);
  }

  header(width: number): string {
    return this.pad(this.label, width);
  }

  /** Reads instance state, so the instance is where it belongs. */
  describe(): string {
    return `formatter ${this.label}`;
  }

  /** `this`-free, but one call site's receiver is a fresh object. */
  trim(value: string, width: number): string {
    return value.trim().slice(0, width);
  }

  /** `this`-free, but handed out as a value. */
  measure(value: string): number {
    return value.length;
  }

  /** `this`-free, but reached through a string key and a `?.`. */
  quote(value: string): string {
    return `"${value}"`;
  }
}
