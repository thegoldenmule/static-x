import type { Tag } from './shapes.js';

/** A boarding kennel with a fixed number of runs. */
export class Kennel {
  static readonly MAX_RUNS = 40;

  readonly name: string;

  /** Dogs currently boarding. */
  occupancy = 0;

  rating = 5;

  #ledger: string[] = [];
  protected auditKey = 'k-1';

  constructor(name: string) {
    this.name = name;
  }

  get vacancies(): number {
    return Kennel.MAX_RUNS - this.occupancy;
  }

  /** Books a dog in, returning the run it was given. */
  book(dog: string, nights = 1): number {
    this.#ledger.push(`${dog}:${String(nights)}`);
    this.occupancy += 1;
    return this.occupancy;
  }

  tag(): Tag {
    return { label: this.name };
  }

  private seal(): void {
    this.#ledger.length = 0;
  }

  static open(name: string): Kennel {
    return new Kennel(name);
  }
}
