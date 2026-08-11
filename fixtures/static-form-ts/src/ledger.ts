import { makeFormatter } from './factory.js';

export function ledgerLine(width: number): string {
  return makeFormatter().trim('  cash  ', width);
}
