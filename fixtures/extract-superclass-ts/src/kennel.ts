import type { Counted, Tag } from './shapes.js';

/** A boarding kennel with a fixed number of runs. */
export class Kennel implements Counted {
  /** Dogs currently boarding. */
  occupancy = 0;

  private ledger: string[] = [];

  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  /** Takes one more dog, returning the new occupancy. */
  admit(): number {
    this.occupancy += 1;
    return this.occupancy;
  }

  release(): number {
    this.occupancy -= 1;
    return this.occupancy;
  }

  book(dog: string): Tag {
    this.ledger.push(dog);
    this.admit();
    return { label: dog };
  }

  get roster(): readonly string[] {
    return this.ledger;
  }
}
