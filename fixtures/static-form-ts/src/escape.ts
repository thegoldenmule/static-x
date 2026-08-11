import type { Formatter } from './formatter.js';

export function widths(fmt: Formatter, cells: string[]): number[] {
  return cells.map(fmt.measure);
}
