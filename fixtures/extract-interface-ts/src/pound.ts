export class Pound {
  readonly town: string;

  private key = 'p-1';

  constructor(town: string) {
    this.town = town;
  }

  /** True when both pounds answer to the same registry key. */
  matches(other: Pound): boolean {
    return other.key === this.key;
  }
}
