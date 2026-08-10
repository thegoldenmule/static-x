import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { inlineFunction } from './inline-function.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/inline-function-ts');
const src = (file: string) => path.join(FIXTURE, 'src', file);

const session = TsProjectSession.open(FIXTURE);
afterAll(() => session.dispose());

describe('ts/refactors/inline-function', () => {
  it('parenthesizes by operand position, not precedence rank', { timeout: 30_000 }, async () => {
    // The case TypeScript's own Inline variable gets wrong: `c - d`
    // with `d = a - b` must become `c - (a - b)`. Both compile; one is
    // arithmetic and the other is a bug.
    const result = await inlineFunction.run(session, { symbol: 'difference' });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.body).toBe('a - b');
    expect(await preview(result.edit, src('consumer.ts'))).toContain('return c - (10 - 4);');
  });

  it('adds no parentheses where none are needed', { timeout: 30_000 }, async () => {
    const result = await inlineFunction.run(session, { symbol: 'shout' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('consumer.ts'))).toContain(
      '`<${word.toUpperCase()}>`',
    );
  });

  it('deletes the declaration it inlined', { timeout: 30_000 }, async () => {
    const result = await inlineFunction.run(session, { symbol: 'difference' });

    const math = await preview(result.edit, src('math.ts'));
    expect(math).not.toContain('export function difference');
    // The functions around it survive intact.
    expect(math).toContain('export function twice');
  });

  it('keeps the declaration when asked', { timeout: 30_000 }, async () => {
    const result = await inlineFunction.run(session, {
      symbol: 'difference',
      keepDeclaration: true,
    });

    expect(await preview(result.edit, src('math.ts'))).toContain('export function difference');
    expect(await preview(result.edit, src('consumer.ts'))).toContain('c - (10 - 4)');
  });

  it('refuses to duplicate an argument that could do something', { timeout: 30_000 }, async () => {
    // twice() reads its parameter twice and bump() increments a counter,
    // so inlining would turn one call into two. Nothing about that is
    // visible to a typecheck.
    await expect(inlineFunction.run(session, { symbol: 'twice' })).rejects.toThrow(
      /could do something observable.*reads it 2 times/s,
    );
  });

  it('refuses when a name in the body means something else at the call site', { timeout: 30_000 }, async () => {
    // scaled()'s body reads a module-local SCALE = 3; shadow.ts declares
    // its own SCALE = 100. Substituting compiles and silently computes a
    // different number — the failure the guard cannot see.
    await expect(inlineFunction.run(session, { symbol: 'scaled' })).rejects.toThrow(
      /"SCALE" means something different there|"SCALE" is not in scope there/,
    );
  });

  it('refuses a body that is not a single expression', { timeout: 30_000 }, async () => {
    await expect(inlineFunction.run(session, { symbol: 'complex' })).rejects.toThrow(
      /not a single expression/,
    );
  });

  it('writes the inline to disk, leaving the project compiling', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await inlineFunction.run(copy, { symbol: 'difference', apply: true });

      expect(result.applied).toBe(true);
      expect(await readFile(path.join(root, 'src/consumer.ts'), 'utf8')).toContain(
        'return c - (10 - 4);',
      );
      expect(await readFile(path.join(root, 'src/math.ts'), 'utf8')).not.toContain(
        'export function difference',
      );

      // An authored substitution that merely looked right would fail here.
      const reopened = TsProjectSession.open(root);
      try {
        expect(
          reopened
            .program()
            .getSemanticDiagnostics()
            .map((diagnostic) => diagnostic.messageText),
        ).toEqual([]);
      } finally {
        await reopened.dispose();
      }
    });
  });
});
