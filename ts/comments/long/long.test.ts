import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import type { Finding } from '../../../core/tool/index.js';
import { TsProjectSession } from '../../project/index.js';
import { findLongCommentsInFile, longComments } from './long.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/basic-ts');

function analyze(source: string, input?: Parameters<typeof findLongCommentsInFile>[1]) {
  const sourceFile = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  return findLongCommentsInFile(sourceFile, input);
}

const lines = (n: number, text = 'filler') =>
  Array.from({ length: n }, (_, i) => `// ${text} ${i}`).join('\n');

describe('findLongCommentsInFile', () => {
  it('flags a line-comment block over the line threshold', () => {
    const findings = analyze(`${lines(4)}\nconst x = 1;`, { maxLines: 3 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'comment.long',
      data: { lines: 4, kind: 'line-block' },
      range: { start: { line: 0, character: 0 } },
    });
  });

  it('flags an overlong block comment by characters', () => {
    const findings = analyze(`/* ${'x'.repeat(200)} */\nconst x = 1;`, { maxChars: 100 });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data).toMatchObject({ kind: 'block' });
  });

  it('does not merge line comments separated by code or blank lines', () => {
    const source = `${lines(2)}\nconst a = 1;\n${lines(2, 'other')}\nconst b = 2;`;
    expect(analyze(source, { maxLines: 3 })).toHaveLength(0);
  });

  it('ignores comment-like text inside strings and templates', () => {
    const source = 'const s = `\n// not 1\n// not 2\n// not 3\n// not 4\n`;\nconst x = 1;';
    expect(analyze(source, { maxLines: 3 })).toHaveLength(0);
  });

  it('skips top-of-file license headers', () => {
    const header = Array.from({ length: 12 }, (_, i) => `// Copyright ${i}`).join('\n');
    expect(analyze(`${header}\nconst x = 1;`)).toHaveLength(0);
    // Same-shaped block that is not a license IS flagged.
    expect(analyze(`${lines(12)}\nconst x = 1;`)).toHaveLength(1);
  });

  it('directive comments split blocks and are never flagged', () => {
    const source = `${lines(2)}\n// eslint-disable-next-line foo\n${lines(2, 'more')}\nconst x = 1;`;
    expect(analyze(source, { maxLines: 3 })).toHaveLength(0);
  });
});

describe('ts/comments/long on the fixture project', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('flags exactly the overlong header in math.ts with defaults', async () => {
    const findings = await longComments.run(session, {});
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file.endsWith('math.ts')).toBe(true);
    expect(findings[0]?.data).toMatchObject({ lines: 11 });
  });

  it('also flags the greeter JSDoc at a tighter threshold', async () => {
    const findings = await longComments.run(session, { maxLines: 5 });
    const files = findings.map((f: Finding) => path.basename(f.file)).sort();
    expect(files).toEqual(['greeter.ts', 'math.ts']);
  });
});
