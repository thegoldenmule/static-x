import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Finding } from '../tool/index.js';
import { applyNovelty } from './novelty.js';

const ROOT = path.resolve('/repo');
const at = (file: string) => path.join(ROOT, file);

function finding(file: string, startLine: number, endLine = startLine, name?: string): Finding {
  return {
    file: at(file),
    range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: 1 } },
    code: 'comment.long',
    message: 'long',
    severity: 'info',
    ...(name === undefined ? {} : { data: { name } }),
  };
}

describe('applyNovelty', () => {
  const changes = { files: [at('a.ts')], lines: new Map([[at('a.ts'), new Set([10, 11])]]) };

  it('changed-lines keeps only findings overlapping an added line', () => {
    const result = applyNovelty([finding('a.ts', 3), finding('a.ts', 10)], {
      novelty: 'changed-lines',
      rootPath: ROOT,
      changes,
    });
    expect(result.applied).toBe('changed-lines');
    expect(result.kept.map((f) => f.range.start.line)).toEqual([10]);
  });

  it('changed-lines keeps a multi-line finding that spans into the change', () => {
    // A comment block starting at line 2 and running to 12 was edited at
    // its end; the author owns it even though it did not start there.
    const result = applyNovelty([finding('a.ts', 2, 12)], {
      novelty: 'changed-lines',
      rootPath: ROOT,
      changes,
    });
    expect(result.kept).toHaveLength(1);
  });

  it('changed-lines degrades to changed-file and says so when no diff is available', () => {
    const result = applyNovelty([finding('a.ts', 3), finding('b.ts', 3)], {
      novelty: 'changed-lines',
      rootPath: ROOT,
      changes: { files: [at('a.ts')] },
    });
    expect(result.applied).toBe('changed-file');
    expect(result.note).toMatch(/no line-level diff/);
    expect(result.kept.map((f) => f.file)).toEqual([at('a.ts')]);
  });

  it('changed-file degrades to none when the event knows no file list', () => {
    const result = applyNovelty([finding('a.ts', 3)], {
      novelty: 'changed-file',
      rootPath: ROOT,
    });
    expect(result.applied).toBe('none');
    expect(result.note).toMatch(/whole project/);
    expect(result.kept).toHaveLength(1);
  });

  it('baseline keeps what the baseline does not account for', () => {
    const baseline = new Map([['a.ts|comment.long|old', 1]]);
    const result = applyNovelty([finding('a.ts', 3, 3, 'old'), finding('a.ts', 9, 9, 'new')], {
      novelty: 'baseline',
      rootPath: ROOT,
      baseline,
    });
    expect(result.applied).toBe('baseline');
    expect(result.kept.map((f) => f.data?.['name'])).toEqual(['new']);
  });

  it('baseline degrades to none, pointing at the command that records one', () => {
    const result = applyNovelty([finding('a.ts', 3)], { novelty: 'baseline', rootPath: ROOT });
    expect(result.applied).toBe('none');
    expect(result.note).toMatch(/static-x baseline/);
  });

  it('none keeps everything', () => {
    const result = applyNovelty([finding('a.ts', 3), finding('b.ts', 4)], {
      novelty: 'none',
      rootPath: ROOT,
      changes,
    });
    expect(result.kept).toHaveLength(2);
  });
});
