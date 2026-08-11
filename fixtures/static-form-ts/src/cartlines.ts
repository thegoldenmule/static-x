import { Money } from './money.js';
import type { Line } from './types.js';

export function scaled(line: Line, factor: number) {
  return Money.scale(line.amount, factor);
}
