import { GREETING } from './sibling.js';

export function greet(name: string): string {
  return `${GREETING}, ${name}`;
}
