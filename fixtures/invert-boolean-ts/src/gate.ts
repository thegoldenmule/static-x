import { isEnabled, isTerminal } from './rules.js';

export function last(level: number): string {
  return isTerminal(level) ? 'end' : 'more';
}

export function gate(level: number): string {
  if (isEnabled(level)) {
    return 'open';
  }
  return 'shut';
}

export function blocked(level: number): boolean {
  return !isEnabled(level);
}

export function width(level: number): number {
  return isEnabled(level) && level > 1 ? 2 : 1;
}
