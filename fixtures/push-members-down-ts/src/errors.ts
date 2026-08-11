/**
 * `Error` is declared in lib.d.ts as an interface plus a var of
 * constructor type, so it resolves to no class declaration. A heritage
 * scan that calls that "opaque" refuses every unrelated hierarchy.
 */
export class DeliveryFailed extends Error {
  constructor(readonly endpoint: string) {
    super(`delivery to ${endpoint} failed`);
  }
}
