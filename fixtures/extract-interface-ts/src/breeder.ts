export class Breeder {
  readonly kennelName: string;

  constructor(kennelName: string) {
    this.kennelName = kennelName;
  }

  greet(): string {
    return `hi from ${this.kennelName}`;
  }
}

/** Takes the class itself, not an instance of it. */
export function spawn(kind: typeof Breeder, name: string): Breeder {
  return new kind(name);
}
