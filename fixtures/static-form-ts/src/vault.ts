export class Vault {
  constructor(readonly id: string) {}

  /**
   * The `this` parameter occupies no slot in the argument list, so
   * `vault` is argument 0 even though it is parameter 1.
   */
  static seal(this: void, vault: Vault, note: string): string {
    return `${vault.id}:${note}`;
  }
}
