let ticks = 0;

/** Increments a module-level counter: calling it twice is not calling it once. */
export function bump(): number {
  ticks += 1;
  return ticks;
}

export function cost(): number {
  return 7;
}
