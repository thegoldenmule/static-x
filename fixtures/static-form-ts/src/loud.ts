export class Greeter {
  protected greeting = 'hello';

  greet(): string {
    return this.greeting;
  }
}

export class Loud extends Greeter {
  /** No `this`, but `super` binds to the receiver all the same. */
  shout(): string {
    return `${super.greet()}!`;
  }
}
