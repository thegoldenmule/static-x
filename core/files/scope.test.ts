import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Finding, Tool } from '../tool/index.js';
import { FINDINGS_ARRAY_SCHEMA } from '../tool/index.js';
import { FileScope, findingInScope, scopeFindings, supportsFileScope } from './scope.js';

/** The TypeScript pack's set; these cases were written against it. */
const EXT: ReadonlySet<string> = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

const ROOT = path.resolve('/projects/app');
const CWD = path.resolve('/projects');
const REAL_DIR = path.resolve(import.meta.dirname);

function finding(file: string, data?: Record<string, unknown>): Finding {
  return {
    file,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    code: 'test.finding',
    message: 'a finding',
    severity: 'info',
    ...(data ? { data } : {}),
  };
}

describe('FileScope', () => {
  it('resolves a relative path against every base, so either reading matches', () => {
    const scope = FileScope.from(['src/a.ts'], [ROOT, CWD], EXT);
    expect(scope.has(path.join(ROOT, 'src/a.ts'))).toBe(true);
    expect(scope.has(path.join(CWD, 'src/a.ts'))).toBe(true);
    expect(scope.has(path.join(ROOT, 'src/b.ts'))).toBe(false);
  });

  it('keeps absolute paths as given', () => {
    const scope = FileScope.from([path.join(ROOT, 'src/a.ts')], [ROOT, CWD], EXT);
    expect(scope.has(path.join(ROOT, 'src/a.ts'))).toBe(true);
    expect(scope.has(path.join(CWD, 'src/a.ts'))).toBe(false);
  });

  it('matches everything beneath a directory entry', () => {
    const scope = FileScope.from(['src/components'], [ROOT], EXT);
    expect(scope.has(path.join(ROOT, 'src/components/button.tsx'))).toBe(true);
    expect(scope.has(path.join(ROOT, 'src/components'))).toBe(true);
    expect(scope.has(path.join(ROOT, 'src/components-legacy/button.tsx'))).toBe(false);
  });

  it('ignores blank entries and duplicate readings', () => {
    const scope = FileScope.from(['', '  ', 'src/a.ts', './src/a.ts'], [ROOT], EXT);
    expect(scope.has(path.join(ROOT, 'src/a.ts'))).toBe(true);
    expect(scope.selectsNothing()).toBe(false);
  });

  it('selects nothing for an empty list or paths that name no source file', () => {
    expect(FileScope.from([], [ROOT], EXT).selectsNothing()).toBe(true);
    expect(FileScope.from(['README.md', 'package-lock.json'], [ROOT], EXT).selectsNothing()).toBe(true);
    expect(FileScope.from(['src/a.ts'], [ROOT], EXT).selectsNothing()).toBe(false);
    expect(FileScope.from(['src/a.mts', 'x.md'], [ROOT], EXT).selectsNothing()).toBe(false);
  });

  // The reason the set is a parameter: a commit touching only another
  // language must short-circuit here, before this pack opens a session
  // it has nothing to say about.
  it('selects nothing for a file another pack owns', () => {
    const SWIFT: ReadonlySet<string> = new Set(['.swift']);
    expect(FileScope.from(['App.swift'], [ROOT], EXT).selectsNothing()).toBe(true);
    expect(FileScope.from(['App.swift'], [ROOT], SWIFT).selectsNothing()).toBe(false);
    expect(FileScope.from(['src/a.ts'], [ROOT], SWIFT).selectsNothing()).toBe(true);
  });

  it('treats a real directory as selecting, whatever its name looks like', () => {
    expect(FileScope.from([REAL_DIR], [ROOT], EXT).selectsNothing()).toBe(false);
    expect(FileScope.from(['files'], [path.dirname(REAL_DIR)], EXT).selectsNothing()).toBe(false);
  });
});

describe('findingInScope', () => {
  const scope = FileScope.from(['src/a.ts'], [ROOT], EXT);

  it('keeps findings in a scoped file', () => {
    expect(findingInScope(finding(path.join(ROOT, 'src/a.ts')), scope, ROOT)).toBe(true);
    expect(findingInScope(finding(path.join(ROOT, 'src/b.ts')), scope, ROOT)).toBe(false);
  });

  it('keeps a group finding anchored elsewhere that spans a scoped file', () => {
    const cycle = finding(path.join(ROOT, 'src/b.ts'), { files: ['src/b.ts', 'src/a.ts'] });
    expect(findingInScope(cycle, scope, ROOT)).toBe(true);
  });

  it('drops a group finding that spans nothing in scope', () => {
    const cycle = finding(path.join(ROOT, 'src/b.ts'), { files: ['src/b.ts', 'src/c.ts'] });
    expect(findingInScope(cycle, scope, ROOT)).toBe(false);
  });

  it('tolerates data.files holding anything', () => {
    expect(findingInScope(finding(path.join(ROOT, 'src/b.ts'), { files: 'nope' }), scope, ROOT)).toBe(
      false,
    );
    expect(findingInScope(finding(path.join(ROOT, 'src/b.ts'), { files: [1, null] }), scope, ROOT)).toBe(
      false,
    );
  });

  it('filters a finding list', () => {
    const findings = [finding(path.join(ROOT, 'src/a.ts')), finding(path.join(ROOT, 'src/b.ts'))];
    expect(scopeFindings(findings, scope, ROOT)).toEqual([findings[0]]);
  });
});

describe('supportsFileScope', () => {
  const tool = (outputSchema: Record<string, unknown>): Tool => ({
    name: 'ts/testing/probe',
    description: 'probe',
    inputSchema: { type: 'object' },
    outputSchema,
    run: () => Promise.resolve(null),
  });

  it('accepts finding tools and refuses tools that return edits', () => {
    expect(supportsFileScope(tool(FINDINGS_ARRAY_SCHEMA))).toBe(true);
    expect(supportsFileScope(tool({ type: 'object', properties: {} }))).toBe(false);
  });
});
