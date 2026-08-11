import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { positionOf, preview, withProjectCopy } from '../testing.js';
import { inlineVariable } from './inline-variable.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/inline-variable-ts');
const src = (file: string) => path.join(FIXTURE, 'src', file);

const session = TsProjectSession.open(FIXTURE);
afterAll(() => session.dispose());

describe('ts/refactors/inline-variable', () => {
  it('parenthesizes by operand position, not precedence rank', { timeout: 30_000 }, async () => {
    // Measured on TypeScript 5.9.3: its own inline.variable turns
    // `const d = a - b; return c - d` into `return c - a-b`. Both
    // compile, and one of them is a different number.
    const result = await inlineVariable.run(session, { symbol: 'OFFSET' });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.value).toBe('10 - 4');
    expect(await preview(result.edit, src('consumer.ts'))).toContain('return total - (10 - 4);');
  });

  it('adds no parentheses where none are needed', { timeout: 30_000 }, async () => {
    const result = await inlineVariable.run(session, { symbol: 'LABEL' });

    expect(result.newDiagnostics).toEqual([]);
    // The literal survives printing as it was written, single quotes and
    // all: the substituted expression is re-parsed as one unit, so the
    // printer has original source text to fall back on.
    expect(await preview(result.edit, src('consumer.ts'))).toContain("return `<${'total'}>`;");
  });

  it('follows an exported constant into another module', { timeout: 30_000 }, async () => {
    // TypeScript's engine returns no edits at all here, and no error.
    const result = await inlineVariable.run(session, { symbol: 'OFFSET' });

    expect(result.readSites).toEqual([
      { file: src('consumer.ts'), line: 5, character: 17 },
    ]);
    // The import named something that is about to stop existing.
    expect(await preview(result.edit, src('consumer.ts'))).toContain(
      "import { LABEL } from './config.js';",
    );
    const config = await preview(result.edit, src('config.ts'));
    expect(config).not.toContain('OFFSET');
    // The JSDoc describing it goes too, and its neighbours stay.
    expect(config).not.toContain('A subtraction');
    expect(config).toContain("export const LABEL = 'total';");
  });

  it('removes a re-export of the constant it inlined', { timeout: 30_000 }, async () => {
    // barrel.ts re-exports MARGIN; deleting the declaration without that
    // specifier is TS2305, and the guard would refuse the whole inline.
    const result = await inlineVariable.run(session, { symbol: 'MARGIN' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('barrel.ts'))).toBe(
      "export { LABEL } from './config.js';\n",
    );
    expect(await preview(result.edit, src('consumer.ts'))).toContain('return width + 8;');
    expect(result.warnings.join('\n')).toMatch(/public surface/);
  });

  it('rewrites a read reached through a namespace object', { timeout: 30_000 }, async () => {
    // `units.STEP` is a member access, not a bare identifier: replacing
    // only the name would leave `units.5`.
    const result = await inlineVariable.run(session, { symbol: 'STEP' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('spacing.ts'))).toContain('return n * 5;');
  });

  it('rewrites a shorthand property to long form', { timeout: 30_000 }, async () => {
    // `{ doubledW }` cannot become `{ w * 2 }` — that is not an object
    // literal at all, and the whole property has to be rewritten.
    const result = await inlineVariable.run(session, { symbol: 'doubledW' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('locals.ts'))).toContain(
      'return { doubledW: (w * 2) };',
    );
  });

  it('takes one declarator out of a list without the others', { timeout: 30_000 }, async () => {
    const result = await inlineVariable.run(session, { symbol: 'one' });

    expect(result.newDiagnostics).toEqual([]);
    const locals = await preview(result.edit, src('locals.ts'));
    expect(locals).toContain('  const other = 2;\n  return 1 + other;');
  });

  it('inlines an impure initializer that is read exactly once', { timeout: 30_000 }, async () => {
    // One evaluation before, one after, in the same order: the refusals
    // below are not a blanket ban on calls.
    const result = await inlineVariable.run(session, { symbol: 'next' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('locals.ts'))).toContain('  return bump() + 1;');
  });

  it('refuses an impure initializer read more than once', { timeout: 30_000 }, async () => {
    // bump() increments a module counter. Inlining turns one call into
    // two, and nothing about that is visible to a typecheck.
    await expect(inlineVariable.run(session, { symbol: 'both' })).rejects.toThrow(
      /could do something observable, and it is read 2 times/,
    );
  });

  it('refuses an allocating initializer read more than once', { timeout: 30_000 }, async () => {
    // The case a purity check alone misses: `{ id: 1 }` calls nothing,
    // and TypeScript's own inline.variable turns `o === o` into
    // `{k: 1} === {k: 1}` — true becomes false, with no diagnostic.
    await expect(inlineVariable.run(session, { symbol: 'row' })).rejects.toThrow(
      /builds a new object every time it is evaluated, and it is read 2 times/,
    );
  });

  it('refuses an impure initializer read behind a branch', { timeout: 30_000 }, async () => {
    // One lexical read is not one evaluation: `flag ? tick : 0` runs it
    // sometimes, where the declaration ran it always.
    await expect(inlineVariable.run(session, { symbol: 'tick' })).rejects.toThrow(
      /sits behind a branch, a loop or a nested function/,
    );
  });

  it('refuses when something observable happens in between', { timeout: 30_000 }, async () => {
    // `const first = bump(); return cost() + first` would become
    // `cost() + bump()`, which calls both in the other order.
    await expect(inlineVariable.run(session, { symbol: 'first' })).rejects.toThrow(
      /observable is evaluated before the read .* reorder the two/s,
    );
  });

  it('refuses when a name means something else at the read', { timeout: 30_000 }, async () => {
    // SCALED is FACTOR * 2 with a module-local FACTOR = 3; shadow.ts
    // declares its own FACTOR = 100. Substituting compiles and returns
    // 300 where it returned 106.
    await expect(inlineVariable.run(session, { symbol: 'SCALED' })).rejects.toThrow(
      /"FACTOR" means something different there/,
    );
  });

  it('refuses an initializer reading a variable assigned elsewhere', { timeout: 30_000 }, async () => {
    // The capture check cannot see this one: `base` resolves to the very
    // same symbol at the read, and still holds a different number by the
    // time the read runs. 7 today, 15 inlined, both compiling.
    await expect(inlineVariable.run(session, { symbol: 'scaled' })).rejects.toThrow(
      /reads "base", which is assigned elsewhere/,
    );
  });

  it('refuses a read in a type position', { timeout: 30_000 }, async () => {
    // `typeof SHAPE` wants a name, and an object literal is not one.
    await expect(inlineVariable.run(session, { symbol: 'SHAPE' })).rejects.toThrow(
      /used where an expression cannot go/,
    );
  });

  it('refuses an exported constant nothing in the project reads', { timeout: 30_000 }, async () => {
    await expect(inlineVariable.run(session, { symbol: 'PUBLIC_TIMEOUT' })).rejects.toThrow(
      /exported and nothing in this project reads it/,
    );
  });

  it('refuses when the declaring module is used as a whole object', { timeout: 30_000 }, async () => {
    // `registry[key]` reads an export that no reference search names, so
    // deleting RATE leaves `undefined` at runtime and nothing at compile
    // time — the failure mode the guard is structurally blind to.
    await expect(inlineVariable.run(session, { symbol: 'RATE' })).rejects.toThrow(
      /imported as a whole namespace object/,
    );
  });

  it('refuses an initializer reading `this` from another receiver', { timeout: 30_000 }, async () => {
    await expect(inlineVariable.run(session, { symbol: 'self' })).rejects.toThrow(
      /reads `this`, which means something else at/,
    );
  });

  it('refuses a `let`', { timeout: 30_000 }, async () => {
    await expect(inlineVariable.run(session, { symbol: 'size' })).rejects.toThrow(
      /declared with `let`/,
    );
  });

  it('refuses a loop binding', { timeout: 30_000 }, async () => {
    await expect(inlineVariable.run(session, { symbol: 'each' })).rejects.toThrow(
      /loop initializer/,
    );
  });

  it('refuses a destructured binding', { timeout: 30_000 }, async () => {
    // Addressed by position: `only` is a BindingElement, which is not a
    // declaration `symbol` can resolve.
    const at = await positionOf(src('locals.ts'), 'width: only');
    await expect(
      inlineVariable.run(session, {
        file: src('locals.ts'),
        line: at.line,
        character: at.character + 'width: '.length,
      }),
    ).rejects.toThrow(/binding is destructured/);
  });

  it('writes the inline to disk, leaving the project compiling', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await inlineVariable.run(copy, { symbol: 'MARGIN', apply: true });

      expect(result.applied).toBe(true);
      expect(await readFile(path.join(root, 'src/consumer.ts'), 'utf8')).toContain(
        'return width + 8;',
      );
      expect(await readFile(path.join(root, 'src/config.ts'), 'utf8')).not.toContain('MARGIN');
      expect(await readFile(path.join(root, 'src/barrel.ts'), 'utf8')).toBe(
        "export { LABEL } from './config.js';\n",
      );

      // An authored edit that merely looked right fails here: the import
      // and the re-export both named something that is now gone.
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
