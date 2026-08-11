/**
 * A second god class, kept apart so one refusal cannot disturb the
 * expectations the order fixture sets.
 */
export class Crate {
  /** Weight of the crate itself. */
  tare = 2;

  /** Weight of the contents. */
  net = 0;

  /** Writes both weights, and takes them as a pattern. */
  fill({ net, tare }: { net: number; tare: number }): void {
    this.net = net;
    this.tare = tare;
  }

  gross(): number {
    return this.tare + this.net;
  }
}
