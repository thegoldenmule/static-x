// Member of the planted 3-file value cycle (a -> b -> c -> a). Every
// export is consumed by another member, so dead-exports stays quiet.
import { stepB } from './cycle-b';

export function stepA(): number {
  return stepB() + 1;
}
