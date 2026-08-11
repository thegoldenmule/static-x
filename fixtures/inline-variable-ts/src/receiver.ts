export class Panel {
  readonly id = 'panel';

  /** `self` is `this` here and something else inside the function. */
  wrap(): () => string {
    const self = this;
    return function (): string {
      return self.id;
    };
  }
}
