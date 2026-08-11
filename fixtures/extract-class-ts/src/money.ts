/** Amounts in minor units, so the arithmetic stays integral. */
export type Money = number;

/** Rounds half away from zero, which is what the finance team audits. */
export function round(value: number): Money {
  return Math.sign(value) * Math.round(Math.abs(value));
}
