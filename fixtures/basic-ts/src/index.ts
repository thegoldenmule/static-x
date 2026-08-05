import { greet, greetAll } from './greeter.js';
import { add } from './math.js';

export function main(): void {
  console.log(greet('world', true));
  console.log(greetAll(['alice', 'bob']).join('\n'));
  console.log(add(2, 3));
}
