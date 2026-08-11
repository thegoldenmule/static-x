/** A base whose subclass overrides one of these members. */
export class BaseLedger {
  format(amount: number): string {
    return String(amount);
  }
}

export class DetailLedger extends BaseLedger {
  /** Shared with the base declaration, so it cannot move alone. */
  format(amount: number): string {
    return `${amount} units`;
  }

  /** Reads the base implementation, which the new class does not extend. */
  plain(amount: number): string {
    return super.format(amount);
  }

  /** Not shared, and touches nothing, so it moves on its own. */
  label = 'detail';
}
