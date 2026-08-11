export class Cart {
  /** An accessor: `Cart.currency` would be a different member kind. */
  get currency(): string {
    return 'USD';
  }
}
