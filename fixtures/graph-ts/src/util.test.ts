// A test file: counts as a consumer of util.ts, but its own export
// (makeLabel) is exempt because the test runner loads it directly.
import { usedHelper } from './util';

export function makeLabel(): string {
  return usedHelper('test');
}
