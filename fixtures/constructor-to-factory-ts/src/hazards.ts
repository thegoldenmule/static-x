export class Escaped {
  constructor(readonly id: string) {}
}

const Alias = Escaped;
export const made = new Alias('x');

export abstract class Shape {
  abstract area(): number;
}

export class Implicit {
  readonly kind = 'implicit';
}

export const implicit = new Implicit();

export class Reflective {
  constructor(readonly tag: string) {
    if (new.target !== Reflective) throw new Error('subclassed');
  }
}

export const reflective = new Reflective('t');

export class Destructured {
  constructor({ a, b }: { a: number; b: number }) {
    void a;
    void b;
  }
}

export const destructured = new Destructured({ a: 1, b: 2 });

export class Registry {
  constructor(readonly slots: number) {}

  static create(): string {
    return 'not a factory';
  }
}

export const registry = new Registry(4);
