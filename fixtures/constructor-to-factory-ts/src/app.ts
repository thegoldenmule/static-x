import { Box, Client, Leaf, Node2 } from './client.js';

export function connect(): string {
  return new Client('example.com').describe();
}

export function connectTwice(): string {
  const a = new Client('a.example', 5);
  const b = new Client('b.example');
  return a.describe() + b.describe();
}

export function boxed(): number {
  return new Box<number>(1).value;
}

export function tree(): string {
  return new Node2('root').label + new Leaf('leaf').label;
}

export function commented(): string {
  return new Client(
    // A directive here must survive the rewrite.
    'commented.example',
    7,
  ).describe();
}
