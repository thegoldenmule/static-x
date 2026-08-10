import { tally } from './counter.js';

export const cases = [tally([1, 2]) === 3, tally([]) === 0];
