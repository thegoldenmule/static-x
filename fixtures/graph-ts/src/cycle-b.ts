// Middle member of the planted value cycle: imports c, feeds a.
import { stepC } from './cycle-c';

export function stepB(): number {
  return stepC() + 1;
}
