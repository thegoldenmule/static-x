import { makeOptions, greet } from './options.js';

export const first = makeOptions('alpha', 1, true);
export const hello = greet('world', false);
