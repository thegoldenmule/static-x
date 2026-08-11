import type { Millis } from './types.js';

declare global {
  interface FrameBudget {
    total: Millis;
  }
}

export {};
