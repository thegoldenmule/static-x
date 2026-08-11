import { OFFSET, LABEL } from './config.js';
import { MARGIN } from './barrel.js';

/** The precedence case: total - (10 - 4), never total - 10 - 4. */
export function net(total: number): number {
  return total - OFFSET;
}

export function heading(): string {
  return `<${LABEL}>`;
}

export function padded(width: number): number {
  return width + MARGIN;
}
