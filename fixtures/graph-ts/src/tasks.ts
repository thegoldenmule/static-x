// Consumed only via a dynamic import('./tasks') in cli.ts; hosts the
// consumption edges for the planted import-form cases.
import './cjs';
import './side';
import legacy = require('./legacy');
import { barrelOwn } from './barrel';
import { usedWidget } from './widget';
import type { Shape } from './shapes';

export function runAll(): string[] {
  const shape: Shape = { kind: usedWidget() };
  return ['lint', 'test', legacy.legacyThing(), barrelOwn, shape.kind];
}
