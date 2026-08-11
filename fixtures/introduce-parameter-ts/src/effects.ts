let ticks = 0;

/** Impure: every call advances the counter. */
export function bump(): number {
  ticks += 1;
  return ticks;
}

export function twice(): string {
  return `${bump()}-${bump()}`;
}

export function once(label: string): string {
  return `${label}#${bump()}`;
}

export function both(): string {
  return `${twice()} ${once('a')}`;
}
