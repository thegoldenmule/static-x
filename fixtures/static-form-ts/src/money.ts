export class Money {
  constructor(readonly cents: number) {}

  /** Scales an amount. The amount is the receiver in all but name. */
  static scale(amount: Money, factor: number): Money {
    return new Money(Math.round(amount.cents * factor));
  }

  static half(amount: Money): Money {
    return Money.scale(amount, 0.5);
  }

  /** Handed out as a value, so its arity is checked by assignability. */
  static bump(amount: Money): Money {
    return new Money(amount.cents + 1);
  }

  /** `this` in a static is the constructor, and would become the instance. */
  static origin(amount: Money): Money {
    return new this(amount.cents);
  }

  /** Reassigns the parameter, and `this` cannot be reassigned. */
  static clamp(amount: Money, max: number): Money {
    amount = new Money(Math.min(amount.cents, max));
    return amount;
  }

  /** Reads the parameter inside a function that binds its own `this`. */
  static repeat(amount: Money, times: number): Money[] {
    const out: Money[] = [];
    function one(): Money {
      return new Money(amount.cents);
    }
    for (let index = 0; index < times; index += 1) out.push(one());
    return out;
  }
}
