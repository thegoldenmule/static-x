import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Finding } from '../../../core/tool/index.js';
import { TsProjectSession } from '../../project/index.js';
import { extractCandidates, staleRefs } from './stale-refs.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/basic-ts');

describe('extractCandidates', () => {
  it('extracts JSDoc tags, code spans, and bare identifiers', () => {
    const comment = [
      '/**',
      ' * Wraps `LegacyGreeter.make()` and forwards to {@link formatSalutation}.',
      ' * @param userName the name',
      ' * @see makeOptions for construction',
      ' * Also touches httpClient internals.',
      ' */',
    ].join('\n');
    const found = extractCandidates(comment);
    const byName = Object.fromEntries(found.map((c) => [c.raw, c.source]));
    expect(byName).toEqual({
      'LegacyGreeter.make()': 'code-span',
      formatSalutation: 'jsdoc-tag',
      userName: 'param-tag',
      makeOptions: 'jsdoc-tag',
      httpClient: 'bare',
    });
  });

  it('ignores prose, stoplisted words, and non-code shapes', () => {
    const found = extractCandidates(
      '// Note that TypeScript handles this Correctly for the parser.',
    );
    expect(found).toEqual([]);
  });

  it('extracts hyphenated filenames whole, never as fragments', () => {
    const found = extractCandidates('// covered by ref-set-sugar.test.ts and `api.ts` here');
    expect(found.map((c) => [c.raw, c.isFile ?? false])).toEqual([
      ['api.ts', true],
      ['ref-set-sugar.test.ts', true],
    ]);
  });

  it('reports offsets that point at the reference', () => {
    const comment = '// see `staleThing` here';
    const [candidate] = extractCandidates(comment);
    expect(comment.slice(candidate!.offset, candidate!.offset + candidate!.raw.length)).toBe(
      'staleThing',
    );
  });
});

describe('ts/comments/stale-refs on the fixture project', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('finds exactly the seeded stale references', async () => {
    const findings = await staleRefs.run(session, {});
    const summary = findings
      .map((f: Finding) => `${path.basename(f.file)}:${f.code}:${String(f.data?.name)}`)
      .sort();
    expect(summary).toEqual([
      'greeter.ts:comment.stale-ref:LegacyGreeter',
      'greeter.ts:comment.stale-ref:formatSalutation',
      'literals.ts:comment.stale-ref:legacy-utils.ts',
      'math.ts:comment.stale-param:minuend',
    ]);
  });

  it('does not flag references that resolve via globals, file, or project', async () => {
    // notes.ts mentions JSON.parse(), defaultConfig, loadConfig(), greet():
    // all resolve (global scope, same file, project-wide) — none flagged.
    const findings = await staleRefs.run(session, {});
    expect(findings.filter((f: Finding) => f.file.endsWith('notes.ts'))).toEqual([]);
  });

  it('resolves string-literal vocabulary, property keys, and real files', async () => {
    // literals.ts references `addWidget` (exists only as a union tag
    // string), removeWidget (object-literal key), keywords, builtins,
    // and math.ts (a real file) — only the missing legacy-utils.ts
    // survives resolution.
    const findings = await staleRefs.run(session, {});
    const inFile = findings.filter((f: Finding) => f.file.endsWith('literals.ts'));
    expect(inFile.map((f: Finding) => f.data?.name)).toEqual(['legacy-utils.ts']);
    expect(inFile[0]?.data).toMatchObject({ kind: 'file' });
  });

  it('reports precise ranges and confidence levels', async () => {
    const findings = await staleRefs.run(session, {});
    const param = findings.find((f: Finding) => f.code === 'comment.stale-param');
    expect(param?.data).toMatchObject({ confidence: 'high', source: 'param-tag' });
    expect(param?.message).toContain('parameters: a, b');
    const span = findings.find((f: Finding) => f.data?.name === 'LegacyGreeter');
    expect(span?.data).toMatchObject({ confidence: 'medium', source: 'code-span' });
  });
});
