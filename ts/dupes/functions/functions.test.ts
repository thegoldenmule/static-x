import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { collectFunctionShapes, dupeFunctions } from './functions.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/dupes-ts');

function shapesOf(source: string, input?: Parameters<typeof collectFunctionShapes>[1]) {
  // setParentNodes false mirrors program-parsed files, whose nodes
  // carry no parent pointers until the checker binds them.
  const sourceFile = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, false);
  return collectFunctionShapes(sourceFile, input);
}

describe('collectFunctionShapes', () => {
  it('gives identical functions the same key and the same normalized text', () => {
    const shapes = shapesOf(
      `function first(a: number): number {
        const b = a + 1;
        return b * 2;
      }
      function second(a: number): number {
        const b = a + 1;
        return b * 2;
      }`,
      { minNodes: 1 },
    );
    expect(shapes.map((s) => s.name)).toEqual(['first', 'second']);
    expect(shapes[0]?.key).toBe(shapes[1]?.key);
    expect(shapes[0]?.normalizedText).toBe(shapes[1]?.normalizedText);
  });

  it('gives renamed-identifier copies the same key but different normalized text', () => {
    // Different normalized text is what later makes the group exact=false.
    const shapes = shapesOf(
      `function sum(items: number[]): number {
        let total = 0;
        for (const item of items) {
          total = total + item;
        }
        return total;
      }
      function tally(rows: number[]): number {
        let acc = 0;
        for (const row of rows) {
          acc = acc + row;
        }
        return acc;
      }`,
      { minNodes: 1 },
    );
    expect(shapes).toHaveLength(2);
    expect(shapes[0]?.key).toBe(shapes[1]?.key);
    expect(shapes[0]?.normalizedText).not.toBe(shapes[1]?.normalizedText);
  });

  it('distinguishes nesting from siblings in the key', () => {
    // Flat preorder kind sequences are identical here; only the
    // per-node child counts in the key separate the two call trees.
    const shapes = shapesOf(
      `function a(): void {
        f(g(x), y);
      }
      function b(): void {
        f(g(x, y));
      }`,
      { minNodes: 1 },
    );
    expect(shapes).toHaveLength(2);
    expect(shapes[0]?.key).not.toBe(shapes[1]?.key);
  });

  it('keeps whitespace inside string literals as part of exactness', () => {
    const shapes = shapesOf(
      `function joinNarrow(xs: string[]): string {
        return xs.join(' | ');
      }
      function joinWide(xs: string[]): string {
        return xs.join(' |  ');
      }`,
      { minNodes: 1 },
    );
    expect(shapes).toHaveLength(2);
    expect(shapes[0]?.key).toBe(shapes[1]?.key);
    expect(shapes[0]?.normalizedText).not.toBe(shapes[1]?.normalizedText);
  });

  it('lets comments differ without breaking exactness', () => {
    const commented = shapesOf(
      `function a(x: number): number {
        /* note */ const y = x + 1; // trailing
        return y;
      }`,
      { minNodes: 1 },
    );
    const bare = shapesOf(
      `function b(x: number): number {
        const y = x + 1;
        return y;
      }`,
      { minNodes: 1 },
    );
    expect(commented[0]?.key).toBe(bare[0]?.key);
    expect(commented[0]?.normalizedText).toBe(bare[0]?.normalizedText);
  });

  it('gives structurally different functions different keys', () => {
    const shapes = shapesOf(
      `function a(x: number): number {
        return x + 1;
      }
      function b(x: number): number {
        if (x > 0) {
          return x;
        }
        return 0;
      }`,
      { minNodes: 1 },
    );
    expect(shapes).toHaveLength(2);
    expect(shapes[0]?.key).not.toBe(shapes[1]?.key);
  });

  it('ignores literal values in the key', () => {
    const shapes = shapesOf(
      `function greetingA(): string {
        return 'alpha' + 1;
      }
      function greetingB(): string {
        return 'beta' + 2;
      }`,
      { minNodes: 1 },
    );
    expect(shapes).toHaveLength(2);
    expect(shapes[0]?.key).toBe(shapes[1]?.key);
    expect(shapes[0]?.normalizedText).not.toBe(shapes[1]?.normalizedText);
  });

  it('excludes functions whose body has fewer than minNodes nodes', () => {
    const source = `function tiny(x: number): number {
      return x + 1;
    }`;
    expect(shapesOf(source)).toEqual([]);
    const nodes = shapesOf(source, { minNodes: 1 })[0]?.nodes ?? 0;
    expect(nodes).toBeGreaterThan(0);
    expect(shapesOf(source, { minNodes: nodes })).toHaveLength(1);
    expect(shapesOf(source, { minNodes: nodes + 1 })).toEqual([]);
  });

  it('excludes getters and setters', () => {
    const shapes = shapesOf(
      `class Box {
        #value = 0;
        get value(): number {
          return this.#value;
        }
        set value(next: number) {
          this.#value = next;
        }
      }`,
      { minNodes: 1 },
    );
    expect(shapes).toEqual([]);
  });

  it('excludes constructors despite their bodies', () => {
    const shapes = shapesOf(
      `class Widget {
        #size: number;
        constructor(size: number) {
          this.#size = size * 2;
        }
      }`,
      { minNodes: 1 },
    );
    expect(shapes).toEqual([]);
  });

  it('is unaffected by JSDoc, on the function or inside its body', () => {
    const documented = shapesOf(
      `/** Adds one to its input. */
      function a(x: number): number {
        /** A local note. */
        const y = x + 1;
        return y;
      }`,
      { minNodes: 1 },
    );
    const bare = shapesOf(
      `function b(x: number): number {
        const y = x + 1;
        return y;
      }`,
      { minNodes: 1 },
    );
    expect(documented[0]?.key).toBe(bare[0]?.key);
    expect(documented[0]?.nodes).toBe(bare[0]?.nodes);
    expect(documented[0]?.normalizedText).toBe(bare[0]?.normalizedText);
    // The range starts at the function keyword, not the JSDoc.
    expect(documented[0]?.range.start.line).toBe(1);
  });

  it('collects declarations, arrows, methods, and function expressions with names', () => {
    const shapes = shapesOf(
      `function declared(x: number): number { return x + 1; }
      const arrowed = (x: number): number => x + 1;
      class Calc {
        method(x: number): number { return x + 1; }
      }
      const obj = { handler: function (x: number): number { return x + 1; } };
      register((x: number): number => { return x + 1; });`,
      { minNodes: 1 },
    );
    expect(shapes.map((s) => s.name)).toEqual([
      'declared',
      'arrowed',
      'method',
      'handler',
      '(anonymous)',
    ]);
    // Same block body everywhere, so the form never changes the key.
    const declared = shapes[0];
    expect(shapes[2]?.key).toBe(declared?.key);
    expect(shapes[3]?.key).toBe(declared?.key);
    expect(shapes[4]?.key).toBe(declared?.key);
  });
});

describe('ts/dupes/functions on the fixture project', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('flags exactly the planted duplicate pairs with defaults', async () => {
    const findings = await dupeFunctions.run(session, {});
    expect(
      findings.map((f) => [
        path.basename(f.file),
        f.data?.name,
        f.severity,
        f.data?.exact,
        f.data?.confidence,
      ]),
    ).toEqual([
      ['alpha.ts', 'normalizeScores', 'warning', true, 'high'],
      ['beta.ts', 'normalizeRatings', 'warning', true, 'high'],
      ['delta.ts', 'mergeStages', 'warning', true, 'high'],
      ['delta.ts', 'mergeSteps', 'warning', true, 'high'],
      // Anonymous functions get a file-qualified ignore key.
      ['epsilon.ts', 'src/epsilon.ts:(anonymous)', 'warning', true, 'high'],
      ['epsilon.ts', 'src/epsilon.ts:(anonymous)', 'warning', true, 'high'],
      ['gamma.ts', 'scoreAlerts', 'info', false, 'medium'],
      ['gamma.ts', 'ratePackets', 'info', false, 'medium'],
    ]);
  });

  it('reports peers with 1-based lines, a shared group id, and the whole-function range', async () => {
    const findings = await dupeFunctions.run(session, {});
    expect(findings[0]).toMatchObject({
      file: path.join(FIXTURE, 'src', 'alpha.ts'),
      code: 'dupes.function',
      range: { start: { line: 0, character: 0 }, end: { line: 13, character: 1 } },
      data: { peers: [{ file: 'src/beta.ts', line: 3 }], nodes: 49 },
    });
    expect(findings[0]?.message).toContain('src/beta.ts:3');
    expect(findings[1]?.data).toMatchObject({ peers: [{ file: 'src/alpha.ts', line: 1 }] });
    expect(findings[0]?.data?.group).toMatch(/^[0-9a-f]{12}$/);
    expect(findings[0]?.data?.group).toBe(findings[1]?.data?.group);
    expect(findings[2]?.data?.group).not.toBe(findings[0]?.data?.group);
    expect(findings[6]?.data).toMatchObject({ peers: [{ file: 'src/gamma.ts', line: 16 }] });
  });

  it('adds the .test.ts and .spec.ts functions with includeTests', async () => {
    const findings = await dupeFunctions.run(session, { includeTests: true });
    expect(
      findings.map((f) => [path.basename(f.file), f.data?.name, f.severity, f.data?.exact]),
    ).toEqual([
      ['alpha.ts', 'normalizeScores', 'warning', true],
      ['beta.ts', 'normalizeRatings', 'warning', true],
      ['delta.ts', 'mergeStages', 'warning', true],
      ['delta.ts', 'mergeSteps', 'warning', true],
      ['epsilon.ts', 'src/epsilon.ts:(anonymous)', 'warning', true],
      ['epsilon.ts', 'src/epsilon.ts:(anonymous)', 'warning', true],
      // scoreAlerts gains an exact twin in render.spec.ts, so its own
      // finding flips to exact while ratePackets stays structural.
      ['gamma.ts', 'scoreAlerts', 'warning', true],
      ['gamma.ts', 'ratePackets', 'info', false],
      ['render.spec.ts', 'scoreAlertsSpec', 'warning', true],
      ['util.test.ts', 'buildFixture', 'warning', true],
      ['util.test.ts', 'buildSample', 'warning', true],
    ]);
  });

  it('fans each member of a three-member group out to two peers', async () => {
    const findings = await dupeFunctions.run(session, { includeTests: true });
    const trio = findings.filter((f) => f.data?.group === findings[6]?.data?.group);
    expect(trio.map((f) => f.data?.peers)).toEqual([
      [
        { file: 'src/gamma.ts', line: 16 },
        { file: 'src/render.spec.ts', line: 4 },
      ],
      [
        { file: 'src/gamma.ts', line: 3 },
        { file: 'src/render.spec.ts', line: 4 },
      ],
      [
        { file: 'src/gamma.ts', line: 3 },
        { file: 'src/gamma.ts', line: 16 },
      ],
    ]);
  });

  it('adds the small pair when minNodes is lowered', async () => {
    const findings = await dupeFunctions.run(session, { minNodes: 5 });
    expect(findings.map((f) => [path.basename(f.file), f.data?.name])).toEqual([
      ['alpha.ts', 'normalizeScores'],
      ['beta.ts', 'normalizeRatings'],
      ['delta.ts', 'mergeStages'],
      ['delta.ts', 'mergeSteps'],
      ['epsilon.ts', 'src/epsilon.ts:(anonymous)'],
      ['epsilon.ts', 'src/epsilon.ts:(anonymous)'],
      ['gamma.ts', 'scoreAlerts'],
      ['gamma.ts', 'ratePackets'],
      ['small.ts', 'double'],
      ['small.ts', 'twice'],
    ]);
    expect(findings[8]).toMatchObject({ severity: 'warning', data: { exact: true, nodes: 6 } });
  });
});
