import type { Formatter } from './formatter.js';

export function dynamic(fmt: Formatter, value: string): string {
  return fmt['quote'](value);
}

export function maybe(fmt: Formatter | undefined, value: string): string {
  return fmt?.quote(value) ?? '';
}
