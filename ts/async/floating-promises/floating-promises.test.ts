import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import type { FloatingPromisesInput } from './floating-promises.js';
import { findFloatingPromisesInFile, floatingPromises } from './floating-promises.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/async-ts');

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

describe('findFloatingPromisesInFile', () => {
  const program = createVirtualProgram({
    '/virtual/basics.ts': `async function load(): Promise<void> {
  return;
}
function done(): void {
  return;
}
const state: { pending?: Promise<void>; flag?: boolean } = {};
export async function scenarios(ok: boolean): Promise<void> {
  load();
  await load();
  void load();
  state.pending = load();
  ok && load();
  !ok;
  delete state.flag;
  done();
  Promise.all([load(), load()]);
  const pending = load();
  pending;
  await pending;
}
`,
    '/virtual/chains.ts': `async function work(): Promise<number> {
  return 1;
}
function logErr(err: unknown): void {
  void err;
}
function onOk(n: number): void {
  void n;
}
function cleanup(): void {
  return;
}
declare const handlers: [(e: unknown) => void];
export function chains(): void {
  work().catch(logErr);
  work().catch();
  work().then(onOk, logErr);
  work().then(onOk);
  work().finally(cleanup);
  work().catch(logErr).finally(cleanup);
  work().catch(logErr).finally(cleanup).finally(cleanup);
  work().then(onOk, logErr).finally(cleanup);
  work().then(onOk).finally(cleanup);
  work().catch(...handlers);
}
`,
    '/virtual/wrappers.ts': `declare const x: Promise<number>;
declare function g(e: unknown): void;
declare function f(n: number): void;
export function wrappers(): void {
  x.catch(g)!;
  x.catch(g) as Promise<unknown>;
  x['catch'](g);
  x['then'](f, g);
  x['then'](f);
  x!;
}
`,
    '/virtual/comma.ts': `async function load(): Promise<void> {
  return;
}
function report(err: unknown): void {
  void err;
}
export function comma(): void {
  (load(), load());
  (load(), load().catch(report));
}
`,
    '/virtual/unions.ts': `declare function maybeLoad(): Promise<void> | undefined;
interface Api {
  load?: () => Promise<void>;
}
declare const api: Api;
declare const maybe: Promise<void> | undefined;
declare function pick(): Promise<void> | number;
declare const num: Promise<void> | number;
function report(err: unknown): void {
  void err;
}
export function unions(): void {
  maybeLoad();
  api.load?.();
  maybe?.catch(report);
  maybe;
  pick();
  num;
}
`,
    '/virtual/compound.ts': `declare function tagged(): Promise<void> & { tag: string };
export async function generics<
  T extends Promise<unknown>,
  U extends PromiseLike<number>,
  V,
>(t: T, u: U, v: V): Promise<void> {
  tagged();
  t;
  u;
  v;
}
`,
    '/virtual/thenable.ts': `export class Reply {
  private sent = false;
  header(name: string, value: string): Reply {
    this.sent = name.length + value.length > 0;
    return this;
  }
  then(onFulfilled?: () => void, onRejected?: (reason: unknown) => void): void {
    void onRejected;
    onFulfilled?.();
  }
}
export class Single {
  then(cb: () => void): void {
    cb();
  }
}
declare function makeThenable(): { then(cb: () => void): void };
declare const reply: Reply;
declare const single: Single;
declare function done(): void;
export function fluent(): void {
  reply.header('x', 'y');
  makeThenable();
  single;
  single.then(done);
}
`,
    '/virtual/nested.ts': `async function work(): Promise<number> {
  return 1;
}
async function inner(): Promise<void> {
  return;
}
export async function outer(): Promise<void> {
  await work().then(async (n) => {
    void n;
    inner();
  });
}
`,
    '/virtual/iife.ts': `async function load(): Promise<void> {
  return;
}
export function kickoff(): void {
  (async () => {
    await load();
  })();
  void (async () => {
    await load();
  })();
}
`,
    '/virtual/preview.ts': `declare function f(s: string): Promise<void>;
async function veryImportantBackgroundRefreshOperation(tag: string): Promise<void> {
  void tag;
  return;
}
export function firehose(): void {
  veryImportantBackgroundRefreshOperation('some-long-descriptive-tag-value-here');
  veryImportantBackgroundRefreshOperation(
    'tag',
  );
  f('${'x'.repeat(56)}\u{1F600}');
}
`,
    '/virtual/sample.test.ts': `async function load(): Promise<void> {
  return;
}
export function trigger(): void {
  load();
}
`,
  });
  const checker = program.getTypeChecker();
  const audit = (file: string, input?: FloatingPromisesInput) =>
    findFloatingPromisesInFile(program.getSourceFile(file)!, checker, input);

  it('flags bare promise statements and Promise.all, never the handled forms', () => {
    const findings = audit('/virtual/basics.ts');
    expect(findings.map((f) => f.data?.preview)).toEqual([
      'load();',
      'Promise.all([load(), load()]);',
      'pending;',
    ]);
    for (const finding of findings) {
      expect(finding).toMatchObject({
        code: 'async.floating-promise',
        severity: 'warning',
        data: { name: 'Promise', kind: 'promise', confidence: 'high' },
      });
    }
  });

  it('ranges a finding over the whole statement', () => {
    const [first] = audit('/virtual/basics.ts');
    expect(first?.range).toEqual({
      start: { line: 8, character: 2 },
      end: { line: 8, character: 9 },
    });
  });

  it('requires a catch argument and both then callbacks; finally is transparent', () => {
    const findings = audit('/virtual/chains.ts');
    // catch(...handlers) is absent: a spread is one argument node, so
    // it counts as a handler even though runtime arity is unknowable.
    expect(findings.map((f) => f.data?.preview)).toEqual([
      'work().catch();',
      'work().then(onOk);',
      'work().finally(cleanup);',
      'work().then(onOk).finally(cleanup);',
    ]);
  });

  it('sees chain links through non-null/cast wrappers and element access', () => {
    const findings = audit('/virtual/wrappers.ts');
    expect(findings.map((f) => [f.data?.preview, f.data?.name, f.severity])).toEqual([
      [`x['then'](f);`, 'Promise', 'warning'],
      ['x!;', 'Promise', 'warning'],
    ]);
  });

  it('judges a comma expression by its right operand, which stores nothing', () => {
    const findings = audit('/virtual/comma.ts');
    expect(findings.map((f) => [f.data?.preview, f.data?.name, f.data?.kind])).toEqual([
      ['(load(), load());', 'Promise', 'promise'],
    ]);
  });

  it('treats a union with any thenable constituent as thenable', () => {
    const findings = audit('/virtual/unions.ts');
    expect(findings.map((f) => [f.data?.preview, f.data?.name, f.data?.kind])).toEqual([
      ['maybeLoad();', 'Promise', 'promise'],
      ['api.load?.();', 'Promise', 'promise'],
      ['maybe;', 'Promise', 'promise'],
      ['pick();', 'Promise', 'promise'],
      ['num;', 'Promise', 'promise'],
    ]);
    expect(findings.every((f) => f.severity === 'warning')).toBe(true);
  });

  it('resolves intersection members and type-parameter constraints to a name', () => {
    const findings = audit('/virtual/compound.ts');
    expect(
      findings.map((f) => [f.data?.preview, f.data?.name, f.data?.kind, f.severity]),
    ).toEqual([
      ['tagged();', 'Promise', 'promise', 'warning'],
      ['t;', 'Promise', 'promise', 'warning'],
      ['u;', 'PromiseLike', 'thenable', 'info'],
    ]);
  });

  it('grades custom thenables info/medium, naming the type or falling back to the callee', () => {
    const findings = audit('/virtual/thenable.ts');
    // single.then(done) is absent: Single.then returns void, so the
    // statement's value is no longer thenable — consumed, per the
    // type-level model, even though no rejection handler exists.
    expect(
      findings.map((f) => [f.data?.preview, f.severity, f.data?.name, f.data?.kind]),
    ).toEqual([
      [`reply.header('x', 'y');`, 'info', 'Reply', 'thenable'],
      ['makeThenable();', 'info', 'makeThenable', 'thenable'],
      ['single;', 'info', 'Single', 'thenable'],
    ]);
    expect(findings.every((f) => f.data?.confidence === 'medium')).toBe(true);
    expect(findings[0]?.message).toContain("'Reply'");
  });

  it('flags a promise-returning IIFE but not a void-discarded async IIFE', () => {
    const findings = audit('/virtual/iife.ts');
    expect(findings.map((f) => f.data?.preview)).toEqual(['(async () => { await load(); })();']);
    expect(findings[0]?.data).toMatchObject({ name: 'Promise', kind: 'promise' });
  });

  it('finds a floating statement inside the callback of a handled statement', () => {
    const findings = audit('/virtual/nested.ts');
    expect(findings.map((f) => [f.data?.preview, f.data?.name, f.data?.kind])).toEqual([
      ['inner();', 'Promise', 'promise'],
    ]);
  });

  it('collapses whitespace and truncates previews to 60 chars, surrogate-safely', () => {
    const findings = audit('/virtual/preview.ts');
    expect(findings).toHaveLength(3);
    const [long, multiline, emoji] = findings.map((f) => f.data?.preview as string);
    expect(long?.length).toBe(60);
    expect(long?.startsWith("veryImportantBackgroundRefreshOperation('")).toBe(true);
    expect(multiline).toBe("veryImportantBackgroundRefreshOperation( 'tag', );");
    // The emoji's high surrogate lands exactly on the truncation
    // boundary; a blind slice would emit ill-formed Unicode.
    expect(emoji).toBe(`f('${'x'.repeat(56)}`);
    expect(/[\uD800-\uDBFF]$/.test(emoji ?? '')).toBe(false);
  });

  it('skips test files only when includeTests is false', () => {
    expect(audit('/virtual/sample.test.ts')).toHaveLength(1);
    expect(audit('/virtual/sample.test.ts', { includeTests: false })).toEqual([]);
    expect(audit('/virtual/basics.ts', { includeTests: false })).toHaveLength(3);
  });
});

describe('ts/async/floating-promises on the fixture project', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('flags exactly the planted floating thenables and nothing else', async () => {
    const findings = await floatingPromises.run(session, {});
    expect(
      findings.map((f) => [
        path.basename(f.file),
        f.code,
        f.data?.kind,
        f.severity,
        f.data?.name,
        f.data?.confidence,
      ]),
    ).toEqual([
      ['floating.ts', 'async.floating-promise', 'promise', 'warning', 'Promise', 'high'],
      ['floating.ts', 'async.floating-promise', 'promise', 'warning', 'Promise', 'high'],
      ['kick.test.ts', 'async.floating-promise', 'promise', 'warning', 'Promise', 'high'],
      ['reply.ts', 'async.floating-promise', 'thenable', 'info', 'Reply', 'medium'],
    ]);
  });

  it('excludes the fixture test file at run level when includeTests is false', async () => {
    const findings = await floatingPromises.run(session, { includeTests: false });
    expect(findings.map((f) => path.basename(f.file))).toEqual([
      'floating.ts',
      'floating.ts',
      'reply.ts',
    ]);
  });

  it('ranges each finding over its statement with a preview of the source', async () => {
    const findings = await floatingPromises.run(session, {});
    expect(findings.map((f) => f.data?.preview)).toEqual([
      'refresh();',
      'refresh().then(onDone);',
      'kick();',
      "reply.header('x-request-id', 'abc123');",
    ]);
    expect(findings[0]).toMatchObject({
      file: path.join(FIXTURE, 'src', 'floating.ts'),
      range: { start: { line: 13, character: 2 }, end: { line: 13, character: 12 } },
    });
    expect(findings[3]).toMatchObject({
      file: path.join(FIXTURE, 'src', 'reply.ts'),
      range: { start: { line: 21, character: 2 }, end: { line: 21, character: 41 } },
    });
  });
});
