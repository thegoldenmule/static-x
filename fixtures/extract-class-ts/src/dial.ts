import { Gauge } from './gauge.js';

/** Reads and writes the pair from outside, so it needs a stub or a rewrite. */
export function nudge(gauge: Gauge): string {
  gauge.level = gauge.level + 5;
  return gauge.label();
}
