import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import type { Finding } from '../../../core/tool/index.js';
import { TsProjectSession } from '../../project/index.js';
import { findLlmTellsInFile, llmTells } from './llm-tells.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/basic-ts');

function analyze(source: string, input?: Parameters<typeof findLlmTellsInFile>[1]) {
  const sourceFile = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  return findLlmTellsInFile(sourceFile, input);
}

describe('findLlmTellsInFile', () => {
  it('flags filler phrasing and reports the matched patterns', () => {
    const findings = analyze(
      "// It's worth noting that this seamlessly leverages the cache.\nconst x = 1;",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data?.matches).toEqual(['worth-noting', 'leverage', 'seamless']);
    expect(findings[0]?.data?.score).toBe(3);
  });

  it('flags change-log prose describing the edit', () => {
    const findings = analyze('// Fixed the bug where retries were skipped.\nconst x = 1;');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data?.matches).toContain('changelog');
  });

  it('flags narration that restates the next line', () => {
    const findings = analyze('// Return the total count\nreturn totalCount;');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data?.matches).toContain('narration');
  });

  it('leaves informative comments alone', () => {
    const source = [
      '// Retries use exponential backoff because the upstream rate',
      '// limiter counts bursts within a 10s window.',
      'const delay = backoff(attempt);',
    ].join('\n');
    expect(analyze(source)).toEqual([]);
  });

  it('respects minScore', () => {
    const source = '// This robust module is designed to help.\nconst x = 1;';
    expect(analyze(source)).toHaveLength(1); // 0.5 + 0.5 = 1 >= default 1
    expect(analyze(source, { minScore: 2 })).toEqual([]);
  });
});

describe('ts/comments/llm-tells on the fixture project', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('flags the seeded header and narration comments in math.ts', async () => {
    const findings = await llmTells.run(session, {});
    const byFile = findings.map(
      (f: Finding) => `${path.basename(f.file)}:${f.range.start.line}`,
    );
    expect(byFile).toEqual(['math.ts:0', 'math.ts:20']);

    const header = findings[0]!;
    expect((header.data?.matches as string[]).length).toBeGreaterThanOrEqual(6);
    expect(findings[1]?.data?.matches).toContain('narration');
  });
});
