import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { findLoopholesInFile, typeLoopholes } from './loopholes.js';
import type { LoopholesInput } from './loopholes.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/loopholes-ts');

function loopholesIn(source: string, input?: LoopholesInput, fileName = 'test.ts') {
  // setParentNodes false mirrors program-parsed files, whose nodes
  // carry no parent pointers until the checker binds them.
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);
  return findLoopholesInFile(sourceFile, input);
}

describe('findLoopholesInFile', () => {
  it('never matches loophole-shaped text inside string or template literals', () => {
    const findings = loopholesIn(
      `const a = 'cast this as any string';
      const b = "// @ts-ignore";
      const c = \`note: @ts-nocheck and x as unknown as T\`;`,
    );
    expect(findings).toEqual([]);
  });

  it('exempts const assertions in both syntaxes', () => {
    const findings = loopholesIn(
      `const nums = [1, 2, 3] as const;
      const tag = <const>['x'];`,
    );
    expect(findings).toEqual([]);
  });

  it('flags a plain assertion as info with the asserted type as name', () => {
    const findings = loopholesIn(`const out = value as Target;`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'types.assertion',
      severity: 'info',
      data: { name: 'Target', kind: 'assertion', confidence: 'high' },
    });
  });

  it('flags as-any as a single warning, with no extra types.any finding', () => {
    const findings = loopholesIn(`const out = value as any;`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'types.assertion',
      severity: 'warning',
      data: { name: 'any', kind: 'as-any' },
    });
  });

  it('flags a double-cast once, at the outer assertion range', () => {
    const findings = loopholesIn(`const out = value as unknown as Target;`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'types.assertion',
      severity: 'warning',
      range: { start: { line: 0, character: 12 }, end: { line: 0, character: 38 } },
      data: { name: 'Target', kind: 'double-cast' },
    });
    expect(findings[0]?.message).toContain("'unknown'");
  });

  it('sees a double-cast through parentheses', () => {
    const findings = loopholesIn(`const out = (value as unknown) as Target;`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data).toMatchObject({ kind: 'double-cast', name: 'Target' });
  });

  it('reports a triple assertion chain once, at the outermost assertion', () => {
    const findings = loopholesIn(
      `const a = value as unknown as B as C;
      const b = ((value as unknown) as B) as C;`,
    );
    expect(findings.map((f) => [f.data?.kind, f.data?.name, f.range.start.line])).toEqual([
      ['double-cast', 'C', 0],
      ['double-cast', 'C', 1],
    ]);
    expect(findings[0]?.message).toContain("'B'");
  });

  it('collapses and truncates inline object-type names for assertions', () => {
    const findings = loopholesIn(
      `const v = data as {
        alpha: string;
        beta: number;
        gamma: boolean;
      };`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data?.name).toBe('{ alpha: string; beta: number; gamma: bo');
  });

  it('handles the angle-bracket assertion form', () => {
    const findings = loopholesIn(
      `const n = <Target>value;
      const m = <any>value;`,
    );
    expect(findings.map((f) => [f.data?.kind, f.severity, f.data?.name])).toEqual([
      ['assertion', 'info', 'Target'],
      ['as-any', 'warning', 'any'],
    ]);
  });

  it('still flags the inner assertion when the outer is an exempt as-const', () => {
    // The const assertion is not an escape hatch, so it neither reports
    // nor shields the real assertion beneath it.
    const findings = loopholesIn(`const out = (value as Target) as const;`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data).toMatchObject({ kind: 'assertion', name: 'Target' });
  });

  it('grades any by position: parameter and return warn, variable is info', () => {
    const findings = loopholesIn(
      `function log(entry: any): any {
        const scratch: any = entry;
        return scratch;
      }`,
    );
    expect(findings.map((f) => [f.code, f.severity])).toEqual([
      ['types.any', 'warning'],
      ['types.any', 'warning'],
      ['types.any', 'info'],
    ]);
    expect(
      findings.every((f) => f.data !== undefined && f.data.name === 'any' && f.data.kind === 'any'),
    ).toBe(true);
  });

  it('keeps the position grade inside nested annotation types', () => {
    const findings = loopholesIn(
      `function fetchAll(): Promise<any> {
        return load();
      }
      let bag: Map<string, any>;`,
    );
    expect(findings.map((f) => [f.range.start.line, f.severity])).toEqual([
      [0, 'warning'],
      [3, 'info'],
    ]);
  });

  it('grades accessor and index-signature any: getter return warns, index value is info', () => {
    const findings = loopholesIn(
      `class Box {
        raw: unknown;
        get val(): any {
          return this.raw;
        }
      }
      interface Bag {
        [key: string]: any;
      }`,
    );
    expect(findings.map((f) => [f.range.start.line, f.severity])).toEqual([
      [2, 'warning'],
      [7, 'info'],
    ]);
  });

  it('grades any inside type aliases: mapped and conditional info, function types by position', () => {
    const findings = loopholesIn(
      `type Loose<T> = { [K in keyof T]: any };
      type Wide<T> = T extends any ? true : false;
      type Fn = (cb: (x: any) => any) => any;`,
    );
    expect(findings.map((f) => [f.range.start.line, f.severity])).toEqual([
      [0, 'info'],
      [1, 'info'],
      [2, 'warning'],
      [2, 'warning'],
      [2, 'warning'],
    ]);
  });

  it('exempts keyof any, the checker-verified spelling of string | number | symbol', () => {
    const findings = loopholesIn(
      `type K = keyof any;
      function f(rec: Record<keyof any, unknown>): void { void rec; }`,
    );
    expect(findings).toEqual([]);
  });

  it('flags non-null assertions as info, truncating long operands in the name', () => {
    const findings = loopholesIn(
      `const n = user!.name;
      const v = veryLongExpressionName.with.more.properties.attached!;`,
    );
    expect(findings.map((f) => [f.code, f.severity, f.data?.name])).toEqual([
      ['types.non-null', 'info', 'user'],
      ['types.non-null', 'info', 'veryLongExpressionName.with.more.propert'],
    ]);
    expect((findings[1]?.data?.name as string).length).toBe(40);
  });

  it('never splits a surrogate pair when truncating a name', () => {
    // The emoji's high surrogate lands exactly on the truncation
    // boundary; a blind slice would emit ill-formed Unicode.
    const findings = loopholesIn(`const v = data['${'x'.repeat(33)}\u{1F600}rest']!;`);
    expect(findings).toHaveLength(1);
    const name = findings[0]?.data?.name as string;
    expect(name).toBe(`data['${'x'.repeat(33)}`);
    expect(/[\uD800-\uDBFF]$/.test(name)).toBe(false);
  });

  it('detects @ts-nocheck at the top of a file', () => {
    const findings = loopholesIn(
      `// @ts-nocheck
      export const one = 1;`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'types.directive',
      severity: 'warning',
      range: { start: { line: 0, character: 0 } },
      data: { name: '@ts-nocheck', kind: '@ts-nocheck' },
    });
  });

  it('grades @ts-expect-error info and @ts-ignore warning', () => {
    const findings = loopholesIn(
      `// @ts-expect-error checked suppression
      const x: number = 'a';
      // @ts-ignore
      const y: number = 'b';`,
    );
    expect(findings.map((f) => [f.data?.kind, f.severity])).toEqual([
      ['@ts-expect-error', 'info'],
      ['@ts-ignore', 'warning'],
    ]);
  });

  it('flags @ts-ignore-me, which tsc honors by prefix match, as @ts-ignore', () => {
    const findings = loopholesIn(
      `// @ts-ignore-me suppression tsc honors
      const x: number = 'a';`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'warning',
      data: { name: '@ts-ignore', kind: '@ts-ignore' },
    });
  });

  it('ignores what tsc ignores: mid-comment mentions and @ts-nocheck lookalikes', () => {
    const findings = loopholesIn(
      `// docs about @ts-ignore live elsewhere
      // @ts-nocheck-me
      const ok = 1;`,
    );
    expect(findings).toEqual([]);
  });

  it('flags block-comment directives on their last line, which tsc honors', () => {
    const findings = loopholesIn(
      `/* @ts-ignore */
      const x: number = 'a';
      /** @ts-expect-error */
      const y: number = 'b';`,
    );
    expect(findings.map((f) => [f.data?.kind, f.severity])).toEqual([
      ['@ts-ignore', 'warning'],
      ['@ts-expect-error', 'info'],
    ]);
  });

  it('ignores block-comment directives off the last line and block @ts-nocheck, like tsc', () => {
    const findings = loopholesIn(
      `/*
       * @ts-ignore
       */
      /* @ts-nocheck */
      const x: number = 'a';`,
    );
    expect(findings).toEqual([]);
  });

  it('keeps @ts-nocheck behind other leading comments as a file-wide warning', () => {
    const findings = loopholesIn(
      `// intro
      // @ts-nocheck
      export const one = 1;`,
    );
    expect(findings.map((f) => [f.data?.kind, f.severity])).toEqual([['@ts-nocheck', 'warning']]);
  });

  it('downgrades a mid-file @ts-nocheck, inert to tsc, to info with an accurate message', () => {
    const findings = loopholesIn(
      `const ok = 1;
      // @ts-nocheck
      const x: number = 'a';`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'types.directive',
      severity: 'info',
      data: { name: '@ts-nocheck', kind: '@ts-nocheck' },
    });
    expect(findings[0]?.message).toContain('before the first statement');
  });

  it('never treats JSX text that merely looks like a comment as a directive', () => {
    const findings = loopholesIn(
      `const el = <div>// @ts-nocheck</div>;
      const big = (
        <div>
          // @ts-ignore
          hello
        </div>
      );`,
      undefined,
      'test.tsx',
    );
    expect(findings).toEqual([]);
  });

  it('still finds loopholes inside JSX attributes and children in .tsx files', () => {
    const findings = loopholesIn(
      `const el = <div title={data as string} count={data as any} ` +
        `wide={data as unknown as string}>{props!.list}</div>;`,
      undefined,
      'test.tsx',
    );
    expect(findings.map((f) => [f.data?.kind, f.severity, f.data?.name])).toEqual([
      ['assertion', 'info', 'string'],
      ['as-any', 'warning', 'any'],
      ['double-cast', 'warning', 'string'],
      ['non-null', 'info', 'props'],
    ]);
  });

  it('returns nothing for test files when includeTests is false', () => {
    const source = `const out = value as any;`;
    expect(loopholesIn(source, { includeTests: false }, 'sample.test.ts')).toEqual([]);
    expect(loopholesIn(source, { includeTests: false }, 'sample.ts')).toHaveLength(1);
    expect(loopholesIn(source, {}, 'sample.test.ts')).toHaveLength(1);
  });
});

describe('ts/types/loopholes on the fixture project', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('flags exactly the planted loopholes with defaults', async () => {
    const findings = await typeLoopholes.run(session, {});
    expect(
      findings.map((f) => [
        path.basename(f.file),
        f.code,
        f.data?.kind,
        f.severity,
        f.data?.name,
      ]),
    ).toEqual([
      ['anys.ts', 'types.any', 'any', 'warning', 'any'],
      ['anys.ts', 'types.any', 'any', 'info', 'any'],
      ['anys.ts', 'types.non-null', 'non-null', 'info', 'names[0]'],
      ['casts.ts', 'types.assertion', 'assertion', 'info', 'Payload'],
      ['casts.ts', 'types.assertion', 'as-any', 'warning', 'any'],
      ['casts.ts', 'types.assertion', 'double-cast', 'warning', 'Payload'],
      ['directives.ts', 'types.directive', '@ts-expect-error', 'info', '@ts-expect-error'],
      ['directives.ts', 'types.directive', '@ts-ignore', 'warning', '@ts-ignore'],
      ['helpers.test.ts', 'types.assertion', 'assertion', 'info', 'Payload'],
      ['nocheck.ts', 'types.directive', '@ts-nocheck', 'warning', '@ts-nocheck'],
      ['widget.tsx', 'types.assertion', 'as-any', 'warning', 'any'],
    ]);
    expect(findings.every((f) => f.data?.confidence === 'high')).toBe(true);
  });

  it('ranges the double-cast over the whole outer assertion', async () => {
    const findings = await typeLoopholes.run(session, {});
    const doubleCast = findings.find((f) => f.data?.kind === 'double-cast');
    expect(doubleCast).toMatchObject({
      file: path.join(FIXTURE, 'src', 'casts.ts'),
      range: { start: { line: 14, character: 9 }, end: { line: 14, character: 36 } },
    });
  });

  it('ranges directives over the comment, any over the keyword, non-null over the expression', async () => {
    const findings = await typeLoopholes.run(session, {});
    expect(findings.find((f) => f.data?.kind === '@ts-nocheck')).toMatchObject({
      file: path.join(FIXTURE, 'src', 'nocheck.ts'),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 14 } },
    });
    expect(findings.find((f) => f.code === 'types.any' && f.severity === 'warning')).toMatchObject(
      {
        file: path.join(FIXTURE, 'src', 'anys.ts'),
        range: { start: { line: 0, character: 30 }, end: { line: 0, character: 33 } },
      },
    );
    expect(findings.find((f) => f.data?.kind === 'non-null')).toMatchObject({
      file: path.join(FIXTURE, 'src', 'anys.ts'),
      range: { start: { line: 7, character: 9 }, end: { line: 7, character: 18 } },
    });
  });

  it('drops the test-file assertion with includeTests false', async () => {
    const findings = await typeLoopholes.run(session, { includeTests: false });
    expect(findings.map((f) => path.basename(f.file))).toEqual([
      'anys.ts',
      'anys.ts',
      'anys.ts',
      'casts.ts',
      'casts.ts',
      'casts.ts',
      'directives.ts',
      'directives.ts',
      'nocheck.ts',
      'widget.tsx',
    ]);
  });
});
