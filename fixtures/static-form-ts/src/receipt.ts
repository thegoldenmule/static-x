import { Formatter as Fmt } from './formatter.js';

export function receipt(width: number): string {
  const fmt = new Fmt('receipt');
  return fmt.pad('due', width);
}
