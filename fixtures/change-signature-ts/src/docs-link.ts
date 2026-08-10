import { instrument } from './documented.js';

/**
 * Wraps a pool. The result is produced by {@link instrument} and cached.
 */
export function wrap(): string {
  return instrument('pool', 'primary');
}
