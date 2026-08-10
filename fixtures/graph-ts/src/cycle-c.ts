// Closing member of the planted value cycle: imports a, feeds b.
import { stepA } from './cycle-a';

export function stepC(): number {
  return stepA() + 1;
}
