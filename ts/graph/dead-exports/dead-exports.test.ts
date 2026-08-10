import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import type { Finding } from '../../../core/tool/index.js';
import { TsProjectSession } from '../../project/index.js';
import { collectModuleRefs } from '../import-graph.js';
import type { FileAuditOptions } from './dead-exports.js';
import {
  deadExports,
  findDeadExportsInFile,
  isFrameworkEntry,
  sourceCandidates,
  translateGlob,
} from './dead-exports.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/graph-ts');

function refsOf(source: string) {
  const sourceFile = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  return collectModuleRefs(sourceFile);
}

describe('collectModuleRefs', () => {
  it('records default, named, and renamed imports by their exported names', () => {
    const refs = refsOf(`import def, { a, b as c } from './x';`);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ specifier: './x', typeOnly: false });
    expect([...(refs[0]?.names ?? [])].sort()).toEqual(['a', 'b', 'default']);
  });

  it('records namespace, star re-export, dynamic import, and require as *', () => {
    const refs = refsOf(
      [
        `import * as ns from './n';`,
        `export * from './s';`,
        `const p = import('./d');`,
        `import legacy = require('./r');`,
      ].join('\n'),
    );
    expect(refs.map((r) => r.names)).toEqual([['*'], ['*'], ['*'], ['*']]);
  });

  it('records a bare require() call as consuming everything', () => {
    const refs = refsOf(`const mod = require('./m');\nrequire(dynamic);\nother('./x');`);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ specifier: './m', names: ['*'], typeOnly: false });
  });

  it('records re-exported names against the source module', () => {
    const refs = refsOf(`export { a as b } from './y';`);
    expect(refs[0]?.names).toEqual(['a']);
  });

  it('marks type-only imports without dropping their names', () => {
    const refs = refsOf(
      `import type { T } from './t';\nimport { type U, value } from './u';\nexport type { V } from './v';`,
    );
    expect(refs[0]).toMatchObject({ typeOnly: true, names: ['T'] });
    expect(refs[1]).toMatchObject({ typeOnly: false, names: ['U', 'value'] });
    expect(refs[2]).toMatchObject({ typeOnly: true, names: ['V'] });
  });

  it('records a side-effect import with no names', () => {
    const refs = refsOf(`import './setup';`);
    expect(refs[0]).toMatchObject({ specifier: './setup', names: [] });
  });

  it('ignores dynamic imports with computed specifiers', () => {
    expect(refsOf('const m = import(name);')).toHaveLength(0);
  });

  it('reads the specifier through new URL(..., import.meta.url) shims', () => {
    const refs = refsOf(
      `await import(new URL('./main.ts', import.meta.url).href);\n` +
        `await import(new URL('./other.ts', import.meta.url));`,
    );
    expect(refs.map((r) => [r.specifier, ...r.names])).toEqual([
      ['./main.ts', '*'],
      ['./other.ts', '*'],
    ]);
  });

  it('ignores new URL specifiers not anchored to import.meta.url', () => {
    expect(refsOf(`const m = import(new URL('./x.ts', base).href);`)).toHaveLength(0);
  });
});

describe('translateGlob', () => {
  it('* stays within one path segment', () => {
    const glob = translateGlob('src/*.ts');
    expect(glob.test('src/a.ts')).toBe(true);
    expect(glob.test('src/nested/a.ts')).toBe(false);
  });

  it('** spans directories, including zero of them', () => {
    const glob = translateGlob('**/util.ts');
    expect(glob.test('util.ts')).toBe(true);
    expect(glob.test('src/deep/util.ts')).toBe(true);
    expect(glob.test('src/util.spec.ts')).toBe(false);
  });

  it('escapes regex metacharacters', () => {
    expect(translateGlob('src/a.ts').test('src/aXts')).toBe(false);
  });
});

describe('sourceCandidates', () => {
  it('maps built js targets to source extensions and src/ siblings', () => {
    const candidates = sourceCandidates('/pkg', 'dist/index.js');
    expect(candidates).toContain(path.join('/pkg', 'dist', 'index.ts'));
    expect(candidates).toContain(path.join('/pkg', 'src', 'index.ts'));
  });

  it('maps declaration targets to implementation sources, not index.d.*', () => {
    const candidates = sourceCandidates('/pkg', 'dist/index.d.ts');
    expect(candidates).toContain(path.join('/pkg', 'src', 'index.ts'));
    expect(candidates).not.toContain(path.join('/pkg', 'src', 'index.d.ts'));
  });

  it('tries every source extension for extensionless targets', () => {
    const candidates = sourceCandidates('/pkg', './src/noext');
    expect(candidates).toEqual(
      expect.arrayContaining([
        path.join('/pkg', 'src', 'noext.ts'),
        path.join('/pkg', 'src', 'noext.tsx'),
        path.join('/pkg', 'src', 'noext.mts'),
      ]),
    );
  });
});

describe('entry-point and test-file classification', () => {
  it('recognizes framework-convention files', () => {
    expect(isFrameworkEntry('app/dashboard/page.tsx')).toBe(true);
    expect(isFrameworkEntry('src/pages/layout.ts')).toBe(true);
    expect(isFrameworkEntry('src/middleware.ts')).toBe(true);
    expect(isFrameworkEntry('vite.config.ts')).toBe(true);
    expect(isFrameworkEntry('.next/types/validator.ts')).toBe(true);
    expect(isFrameworkEntry('apps/web/.next/types/link.ts')).toBe(true);
    expect(isFrameworkEntry('src/app/util.ts')).toBe(false);
    expect(isFrameworkEntry('shapp/page.ts')).toBe(false);
  });
});

const VIRTUAL_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
};

/** A checker-backed program over in-memory files, no fixture needed. */
function createVirtualProgram(files: Record<string, string>): ts.Program {
  const base = ts.createCompilerHost(VIRTUAL_OPTIONS, true);
  const host: ts.CompilerHost = {
    ...base,
    fileExists: (fileName) => fileName in files || base.fileExists(fileName),
    readFile: (fileName) => files[fileName] ?? base.readFile(fileName),
    getSourceFile: (fileName, languageVersion, ...rest) => {
      const text = files[fileName];
      return text !== undefined
        ? ts.createSourceFile(fileName, text, languageVersion, true)
        : base.getSourceFile(fileName, languageVersion, ...rest);
    },
  };
  return ts.createProgram(Object.keys(files), VIRTUAL_OPTIONS, host);
}

describe('findDeadExportsInFile', () => {
  const program = createVirtualProgram({
    '/virtual/barrel.ts': `export * from './leaf';\nexport const own = 1;\n`,
    '/virtual/leaf.ts': `export const kept = 1;\nexport const alsoKept = 2;\n`,
    '/virtual/thing.ts': `export default function greatDefault(): number {\n  return 2;\n}\n`,
    '/virtual/anon.ts': `export default 42;\n`,
    '/virtual/cjs.ts': `function cjsThing(): number {\n  return 1;\n}\nexport = cjsThing;\n`,
  });
  const checker = program.getTypeChecker();
  const audit = (file: string, consumed: string[], options?: FileAuditOptions) =>
    findDeadExportsInFile(program.getSourceFile(file)!, checker, new Set(consumed), options);

  it('audits only symbols declared in the file, never star-forwarded ones', () => {
    const findings = audit('/virtual/barrel.ts', []);
    expect(findings.map((f) => f.data?.name)).toEqual(['own']);
    expect(findings[0]?.file).toBe('/virtual/barrel.ts');
  });

  it('reports nothing when the file is consumed as *', () => {
    expect(audit('/virtual/barrel.ts', ['*'])).toEqual([]);
  });

  it('skips consumed names and export= symbols', () => {
    expect(audit('/virtual/barrel.ts', ['own'])).toEqual([]);
    expect(audit('/virtual/cjs.ts', [])).toEqual([]);
  });

  it('names a dead default export after its declaration', () => {
    const [finding] = audit('/virtual/thing.ts', []);
    expect(finding).toMatchObject({
      severity: 'warning',
      data: { name: 'greatDefault', kind: 'value', confidence: 'high' },
    });
    expect(finding?.message).toContain('The default export ("greatDefault")');
  });

  it('falls back to "default" for anonymous default exports', () => {
    const [finding] = audit('/virtual/anon.ts', []);
    expect(finding?.data?.name).toBe('default');
    expect(finding?.message).toContain('The default export is imported nowhere');
  });

  it('drops value confidence to medium for approximate consumption', () => {
    const [finding] = audit('/virtual/thing.ts', [], { approximate: true });
    expect(finding?.data).toMatchObject({ confidence: 'medium' });
  });
});

describe('ts/graph/dead-exports on the fixture project', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  const summarize = (findings: Finding[]) =>
    findings
      .map((f) => ({
        code: f.code,
        name: f.data?.name as string,
        file: path.basename(f.file),
      }))
      .sort((a, b) => (a.code + a.name < b.code + b.name ? -1 : 1));

  it('flags exactly the planted dead exports, dead files, and nothing else', async () => {
    const findings = await deadExports.run(session, {});
    expect(summarize(findings)).toEqual([
      { code: 'graph.dead-export', name: 'DeadShape', file: 'shapes.ts' },
      { code: 'graph.dead-export', name: 'UnusedOptions', file: 'util.ts' },
      { code: 'graph.dead-export', name: 'sideNote', file: 'side.ts' },
      { code: 'graph.dead-export', name: 'unusedHelper', file: 'util.ts' },
      { code: 'graph.dead-export', name: 'unusedWidget', file: 'widget.ts' },
      { code: 'graph.dead-file', name: 'src/ambient.ts', file: 'ambient.ts' },
      { code: 'graph.dead-file', name: 'src/empty.ts', file: 'empty.ts' },
      { code: 'graph.dead-file', name: 'src/orphan.ts', file: 'orphan.ts' },
      { code: 'graph.dead-file', name: 'src/requirer.ts', file: 'requirer.ts' },
    ]);
  });

  it('returns findings sorted by file, then position', async () => {
    const findings = await deadExports.run(session, {});
    const keys = findings.map(
      (f) => [f.file, f.range.start.line, f.range.start.character] as const,
    );
    const sorted = [...keys].sort(
      (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || a[1] - b[1] || a[2] - b[2],
    );
    expect(keys).toEqual(sorted);
  });

  it('handles an empty source file without crashing, hedged like a script', async () => {
    const findings = await deadExports.run(session, {});
    const empty = findings.find((f) => f.data?.name === 'src/empty.ts');
    expect(empty).toMatchObject({
      code: 'graph.dead-file',
      severity: 'info',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      data: { kind: 'file', confidence: 'low' },
    });
  });

  it('keeps files alive that only hidden-directory program files import', async () => {
    // src/.gen/gen.ts (generated, excluded from findings) imports
    // only-gen.ts; src/.gen/hcycle.ts imports hid-a.ts.
    const findings = await deadExports.run(session, {});
    const names = new Set(findings.map((f) => f.data?.name));
    expect(names.has('src/only-gen.ts')).toBe(false);
    expect(names.has('onlyGen')).toBe(false);
    expect(names.has('src/hid-a.ts')).toBe(false);
    expect(names.has('hidA')).toBe(false);
  });

  it('keeps files alive that only a bare require() call consumes', async () => {
    const findings = await deadExports.run(session, {});
    expect(findings.some((f) => f.file.endsWith('req-target.ts'))).toBe(false);
    // The requiring file itself is imported by nothing and stays dead.
    expect(findings.some((f) => f.data?.name === 'src/requirer.ts')).toBe(true);
  });

  it('classifies value vs type exports with severity and confidence', async () => {
    const findings = await deadExports.run(session, {});
    const byName = new Map(findings.map((f) => [f.data?.name, f]));
    expect(byName.get('unusedHelper')).toMatchObject({
      severity: 'warning',
      data: { kind: 'value', confidence: 'high', importersOfFile: 1 },
      range: { start: { line: 4, character: 16 } },
    });
    expect(byName.get('UnusedOptions')).toMatchObject({
      severity: 'info',
      data: { kind: 'type', confidence: 'medium', importersOfFile: 1 },
      range: { start: { line: 8, character: 17 } },
    });
    // Shape stays alive through tasks.ts's type-only import.
    expect(byName.get('DeadShape')).toMatchObject({
      severity: 'info',
      data: { kind: 'type', confidence: 'medium' },
    });
    expect(byName.has('Shape')).toBe(false);
  });

  it('reports a dead default export under its declaration name', async () => {
    const findings = await deadExports.run(session, {});
    const widget = findings.find((f) => f.data?.name === 'unusedWidget');
    expect(widget).toMatchObject({
      code: 'graph.dead-export',
      severity: 'warning',
      data: { kind: 'value', confidence: 'high' },
      range: { start: { line: 6, character: 24 } },
    });
    expect(widget?.message).toContain('The default export ("unusedWidget")');
  });

  it('reports a dead file once, not once per export', async () => {
    const findings = await deadExports.run(session, {});
    const orphan = findings.filter((f) => f.file.endsWith('orphan.ts'));
    expect(orphan).toHaveLength(1);
    expect(orphan[0]).toMatchObject({
      code: 'graph.dead-file',
      severity: 'warning',
      range: { start: { line: 0, character: 0 } },
      data: { name: 'src/orphan.ts', kind: 'file', confidence: 'high', importersOfFile: 0 },
    });
    expect(orphan[0]?.range.end.line).toBe(0);
  });

  it('hedges dead-file confidence for script files that declare globals', async () => {
    const findings = await deadExports.run(session, {});
    const ambient = findings.find((f) => f.data?.name === 'src/ambient.ts');
    expect(ambient).toMatchObject({
      code: 'graph.dead-file',
      severity: 'info',
      data: { kind: 'file', confidence: 'low' },
    });
    expect(ambient?.message).toContain('ambient globals');
  });

  it('never re-audits star re-exported names against the barrel consumers', async () => {
    const findings = await deadExports.run(session, {});
    const files = new Set(findings.map((f) => path.basename(f.file)));
    expect(files.has('barrel.ts')).toBe(false);
    expect(files.has('star-source.ts')).toBe(false);
  });

  it('keeps namespace-, dynamic-, alias-, require-, type-only-, side-effect-, and re-export-consumed files alive', async () => {
    const findings = await deadExports.run(session, {});
    // geometry (import * as ns), tasks (dynamic import), aliased (paths
    // alias), legacy (import = require), cjs (side-effect import of an
    // export= module), req-target (bare require call), side
    // (side-effect import; only its export is dead), lib (re-export
    // chain through the entry), and star-source (star re-export from
    // barrel) all stay alive.
    expect(new Set(findings.map((f) => path.basename(f.file)))).toEqual(
      new Set([
        'ambient.ts',
        'empty.ts',
        'orphan.ts',
        'requirer.ts',
        'shapes.ts',
        'side.ts',
        'util.ts',
        'widget.ts',
      ]),
    );
  });

  it('exempts every package.json entry target, including shim-imported files', async () => {
    const findings = await deadExports.run(session, {});
    const flagged = new Set(findings.map((f) => path.basename(f.file)));
    const exempt = [
      'index.ts', // main
      'esm.ts', // module
      'types-entry.ts', // types: dist/*.d.ts mapped back to src/*.ts
      'cli.ts', // bin
      'shimmed.ts', // imported by the bin/shim.mjs non-source target
      'exp.ts', // exports condition object
      'built.ts', // exports dist/*.js mapped back to src/*.ts
      'noext.ts', // extensionless exports target
      'page.tsx', // framework convention
    ];
    for (const file of exempt) {
      expect(flagged.has(file), file).toBe(false);
    }
  });

  it('exempts files matched by an entryPoints glob', async () => {
    const findings = await deadExports.run(session, { entryPoints: ['**/util.ts'] });
    expect(summarize(findings)).toEqual([
      { code: 'graph.dead-export', name: 'DeadShape', file: 'shapes.ts' },
      { code: 'graph.dead-export', name: 'sideNote', file: 'side.ts' },
      { code: 'graph.dead-export', name: 'unusedWidget', file: 'widget.ts' },
      { code: 'graph.dead-file', name: 'src/ambient.ts', file: 'ambient.ts' },
      { code: 'graph.dead-file', name: 'src/empty.ts', file: 'empty.ts' },
      { code: 'graph.dead-file', name: 'src/orphan.ts', file: 'orphan.ts' },
      { code: 'graph.dead-file', name: 'src/requirer.ts', file: 'requirer.ts' },
    ]);
    expect(await deadExports.run(session, { entryPoints: ['src/*.ts'] })).toEqual([]);
  });

  it('treats names imported by extraRoots consumers as consumed', async () => {
    const findings = await deadExports.run(session, { extraRoots: ['consumers'] });
    expect(summarize(findings)).toEqual([
      { code: 'graph.dead-export', name: 'DeadShape', file: 'shapes.ts' },
      { code: 'graph.dead-export', name: 'UnusedOptions', file: 'util.ts' },
      { code: 'graph.dead-export', name: 'sideNote', file: 'side.ts' },
      { code: 'graph.dead-export', name: 'unusedWidget', file: 'widget.ts' },
      { code: 'graph.dead-file', name: 'src/ambient.ts', file: 'ambient.ts' },
      { code: 'graph.dead-file', name: 'src/empty.ts', file: 'empty.ts' },
      { code: 'graph.dead-file', name: 'src/orphan.ts', file: 'orphan.ts' },
      { code: 'graph.dead-file', name: 'src/requirer.ts', file: 'requirer.ts' },
    ]);
  });

  it('drops value-export confidence to medium when extraRoots are provided', async () => {
    const findings = await deadExports.run(session, { extraRoots: ['consumers-unrelated'] });
    expect(findings).toHaveLength(9);
    const helper = findings.find((f) => f.data?.name === 'unusedHelper');
    expect(helper?.data).toMatchObject({ kind: 'value', confidence: 'medium' });
  });

  it('consumes everything when an extraRoot namespace-imports the package', async () => {
    expect(await deadExports.run(session, { extraRoots: ['consumers-star'] })).toEqual([]);
  });
});
