export class Vault {
  #pin = '0000';

  /** Failed attempts since the last reset. */
  attempts = 0;

  /** Stays behind, and reads the private name. */
  check(candidate: string): boolean {
    if (candidate === this.#pin) return true;
    this.attempts += 1;
    return false;
  }
}
