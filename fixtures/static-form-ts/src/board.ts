import { makeFormatter } from './factory.js';

export function board(width: number): string {
  const fmt = makeFormatter();
  return `${fmt.label} ${fmt.pad('total', width)}`;
}
