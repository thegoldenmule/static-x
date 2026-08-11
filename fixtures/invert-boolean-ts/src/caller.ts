import { report } from './options.js';

export function summary(): string {
  return report(true, 'run');
}

export function terse(flag: boolean): string {
  return report(!flag, 'run');
}

export function pair(flag: boolean): string {
  return `${report(flag, 'a')}/${report(flag === true, 'b')}`;
}

export function both(a: boolean, b: boolean): string {
  return report(a && b, 'run');
}
