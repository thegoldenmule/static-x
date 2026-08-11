export class Clock {
  now(): number {
    return 0;
  }
}

type Constructor = new (...args: any[]) => object;

/**
 * An unrelated mixin. Its heritage clause resolves to a call expression
 * rather than a class, so the scan cannot follow it — but the only class
 * it names is Clock, so it cannot hide a subclass of Channel.
 */
export function WithLogging<T extends Constructor>(base: T) {
  return class extends base {
    logged = true;
  };
}

export class LoggedClock extends WithLogging(Clock) {}
