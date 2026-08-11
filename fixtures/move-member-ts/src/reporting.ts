import { ParseFault, QuotaFault, TimeoutFault } from './faults.js';

/**
 * Uses `ParseFault` only through its static, so demoting that static to
 * a module binding orphans the specifier — while the demoted name has to
 * be imported from the very same list.
 */
export function describeFault(error: unknown): string {
  if (ParseFault.isFault(error)) return 'parse';
  if (error instanceof TimeoutFault) return 'timeout';
  if (error instanceof QuotaFault) return 'quota';
  return 'unknown';
}
