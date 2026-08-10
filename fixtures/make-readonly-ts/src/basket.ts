export class Basket {
  /** Never reassigned, but mutated in place — readonly stops neither. */
  items: string[] = [];

  constructor(private owner: string) {}

  add(item: string): void {
    this.items.push(item);
  }

  describe(): string {
    return `${this.owner}: ${this.items.join(', ')}`;
  }
}

/** A second `items` in the project, so `class` has something to do. */
export class Crate {
  items: string[] = [];
}
