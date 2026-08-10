import { greet } from './lib.js';
import { makeWidget } from './Widget.js';

export function main(): string {
  return greet(makeWidget('w1').id);
}
