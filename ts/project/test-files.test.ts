import { describe, expect, it } from 'vitest';
import { isTestFile } from './test-files.js';

describe('isTestFile', () => {
  it('recognizes every extension and suffix branch', () => {
    expect(isTestFile('/p/a.test.ts')).toBe(true);
    expect(isTestFile('/p/a.test.tsx')).toBe(true);
    expect(isTestFile('/p/a.spec.ts')).toBe(true);
    expect(isTestFile('/p/a.spec.tsx')).toBe(true);
    expect(isTestFile('/p/a.test.mts')).toBe(true);
    expect(isTestFile('/p/a.spec.cts')).toBe(true);
    expect(isTestFile('/p/a.integration.test.ts')).toBe(true);
  });

  it('rejects names that merely contain test or spec', () => {
    expect(isTestFile('/p/attest.ts')).toBe(false);
    expect(isTestFile('/p/aspec.tsx')).toBe(false);
    expect(isTestFile('/p/test.ts')).toBe(false);
    expect(isTestFile('/p/a.test.js')).toBe(false);
  });
});
