import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDiff } from './changes.js';

const ROOT = path.resolve('/repo');
const at = (file: string) => path.join(ROOT, file);

describe('parseDiff', () => {
  it('reads the added-line range out of each hunk header, 0-based', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -12,0 +13,2 @@ class Thing {',
      '+  one',
      '+  two',
      '@@ -40,1 +42 @@',
      '+  forty-two',
      '',
    ].join('\n');
    // 13,2 covers 1-based 13-14, and a missing count means one line.
    expect(parseDiff(diff, ROOT)).toEqual(new Map([[at('src/a.ts'), new Set([12, 13, 41])]]));
  });

  it('ignores hunks that only delete', () => {
    const diff = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -5,3 +4,0 @@', '-gone'].join('\n');
    expect(parseDiff(diff, ROOT)).toEqual(new Map());
  });

  it('ignores a deleted file, which has no lines to attribute', () => {
    const diff = ['--- a/src/gone.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-x'].join('\n');
    expect(parseDiff(diff, ROOT)).toEqual(new Map());
  });

  it('keeps files apart and resolves paths against the repository root', () => {
    const diff = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -0,0 +1 @@',
      '+a',
      '--- a/pkg/b.ts',
      '+++ b/pkg/b.ts',
      '@@ -0,0 +9,2 @@',
      '+b',
      '+b',
    ].join('\n');
    expect(parseDiff(diff, ROOT)).toEqual(
      new Map([
        [at('src/a.ts'), new Set([0])],
        [at('pkg/b.ts'), new Set([8, 9])],
      ]),
    );
  });

  it('survives a diff of a new file, whose old side is /dev/null', () => {
    const diff = ['--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,3 @@', '+a', '+b', '+c'].join('\n');
    expect(parseDiff(diff, ROOT)).toEqual(new Map([[at('src/new.ts'), new Set([0, 1, 2])]]));
  });
});
