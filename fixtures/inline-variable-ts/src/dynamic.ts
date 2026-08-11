import * as registry from './registry.js';
import { RATE } from './registry.js';

/** Which export this reads is a runtime fact, so no search names it. */
export function setting(key: keyof typeof registry): number {
  return registry[key];
}

export function half(n: number): number {
  return n * RATE;
}
