import { Counter } from './counter.js';

export function headroom(counter: Counter): number {
  return counter.limit - counter.room();
}
