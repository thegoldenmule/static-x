import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { extract } from './extract.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/refactor-core-ts');
const PRICING = path.join(FIXTURE, 'src/pricing.ts');

const session = TsProjectSession.open(FIXTURE);
afterAll(() => session.dispose());

describe('ts/refactors/extract', () => {
  it('reports the available scopes and edits nothing without one', { timeout: 30_000 }, async () => {
    const result = await extract.run(session, {
      file: 'src/pricing.ts',
      select: 'line.qty * line.unit',
    });

    expect(result.applied).toBe(false);
    expect(result.edit.changes).toEqual({});
    expect(result.selected?.text).toBe('line.qty * line.unit');
    // TypeScript's own descriptions are the useful part: they say which
    // enclosing function or class each scope refers to.
    expect(result.scopes.map((scope) => scope.scope)).toContain('function_scope_1');
    expect(result.scopes.map((scope) => scope.scope)).toContain('constant_scope_0');
    expect(result.scopes.find((scope) => scope.scope === 'function_scope_0')?.description).toMatch(
      /totalPrice/,
    );
  });

  it('extracts a statement run into a function, named as asked', { timeout: 30_000 }, async () => {
    const result = await extract.run(session, {
      file: 'src/pricing.ts',
      select: 'let total = 0;\nfor (const line of lines) { total += line.qty * line.unit; }',
      within: 'totalPrice',
      scope: 'function_scope_1',
      name: 'sumLines',
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.name).toBe('sumLines');

    const text = await preview(result.edit, PRICING);
    expect(text).toContain('function sumLines(');
    expect(text).toContain('let total = sumLines(lines);');
    // The placeholder must be gone everywhere, not just at the call.
    expect(text).not.toContain('newFunction');
    // Dry run: disk untouched.
    expect(await readFile(PRICING, 'utf8')).not.toContain('sumLines');
  });

  it('computes parameters from data flow through the selection', { timeout: 30_000 }, async () => {
    const result = await extract.run(session, {
      file: 'src/pricing.ts',
      select: 'line.qty * line.unit',
      scope: 'function_scope_1',
      name: 'lineTotal',
    });

    const text = await preview(result.edit, PRICING);
    // `line` is captured from the enclosing loop, so it becomes a
    // parameter with its inferred type — the work that makes this
    // semantic rather than a copy-paste.
    expect(text).toContain('function lineTotal(line: Line)');
    expect(text).toContain('total += lineTotal(line);');
  });

  it('extracts an expression to a constant', { timeout: 30_000 }, async () => {
    const result = await extract.run(session, {
      file: 'src/pricing.ts',
      select: 'Math.round(taxed * 100)',
      scope: 'constant_scope_0',
      name: 'rounded',
    });

    const text = await preview(result.edit, PRICING);
    expect(text).toContain('const rounded = Math.round(taxed * 100);');
    expect(text).toContain('return rounded / 100;');
  });

  it('refuses a scope it did not offer, listing the ones it did', { timeout: 30_000 }, async () => {
    await expect(
      extract.run(session, {
        file: 'src/pricing.ts',
        select: 'line.qty * line.unit',
        scope: 'function_scope_9',
      }),
    ).rejects.toThrow(/not an available scope.*function_scope_0/s);
  });

  it('refuses a selection that is not a whole node', { timeout: 30_000 }, async () => {
    // TypeScript would widen this to `line.qty * line.unit` and extract
    // that instead, reporting nothing amiss.
    await expect(
      extract.run(session, { file: 'src/pricing.ts', select: 'qty * line.uni' }),
    ).rejects.toThrow(/not a whole statement/);
  });

  it('rejects a name that is not an identifier', { timeout: 30_000 }, async () => {
    await expect(
      extract.run(session, {
        file: 'src/pricing.ts',
        select: 'line.qty * line.unit',
        scope: 'constant_scope_0',
        name: 'not a name',
      }),
    ).rejects.toThrow(/not a valid identifier/);
  });
});

describe('ts/refactors/extract apply mode', () => {
  it('writes the extraction to disk and leaves the project compiling', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await extract.run(copy, {
        file: 'src/pricing.ts',
        select: 'Math.round(taxed * 100)',
        scope: 'constant_scope_0',
        name: 'rounded',
        apply: true,
      });

      expect(result.applied).toBe(true);
      expect(result.newDiagnostics).toEqual([]);

      const text = await readFile(path.join(root, 'src/pricing.ts'), 'utf8');
      expect(text).toContain('const rounded = Math.round(taxed * 100);');
      expect(text).not.toContain('newLocal');
    });
  });
});
