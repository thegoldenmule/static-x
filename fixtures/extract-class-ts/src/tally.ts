/** Two members whose bodies no member-move can describe. */
export class Tally {
  total = 0;

  /** Reaches a member through a key no analysis can read. */
  bump(key: 'total'): void {
    this[key] += 1;
  }

  /** Hands the whole receiver out as a value. */
  self(): Tally {
    return this;
  }
}
