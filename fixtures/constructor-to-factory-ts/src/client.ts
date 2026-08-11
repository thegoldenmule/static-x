export class Client {
  private readonly retries: number;

  /** Opens a client against `host`. */
  constructor(
    readonly host: string,
    retries = 3,
  ) {
    this.retries = retries;
  }

  describe(): string {
    return `${this.host} (${String(this.retries)})`;
  }
}

export class Box<T> {
  constructor(readonly value: T) {}
}

export class Node2 {
  constructor(readonly label: string) {}
}

export class Leaf extends Node2 {
  constructor(label: string) {
    super(label);
  }
}
