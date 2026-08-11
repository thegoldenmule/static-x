export interface Named {
  readonly name: string;
}

export interface Aged {
  readonly age: number;
}

export interface Speaker {
  speak(): string;
}

/** A type alias over a literal: its own type symbol is called `__type`. */
export type Vitals = {
  readonly age: number;
  readonly breed: string;
};

export abstract class Animal implements Named, Speaker {
  constructor(readonly name: string) {}
  abstract speak(): string;
}

export class Dog extends Animal implements Aged {
  constructor(
    name: string,
    readonly age: number,
    readonly breed: string,
  ) {
    super(name);
  }

  speak(): string {
    return 'woof';
  }

  fetch(): string {
    return `${this.name} fetched`;
  }
}
