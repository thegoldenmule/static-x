// Consumed only via `import legacy = require('./legacy')`, which keeps
// every export alive.
export function legacyThing(): string {
  return 'legacy';
}
