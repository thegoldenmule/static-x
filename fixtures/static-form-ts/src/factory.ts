import { Formatter } from './formatter.js';

export function makeFormatter(): Formatter {
  return new Formatter('ledger');
}
