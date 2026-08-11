import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { inlineField } from './inline-field.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/inline-field-ts');
const src = (file: string) => path.join(FIXTURE, 'src', file);

describe('ts/refactors/inline-field', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('inlines a field across modules and deletes it', { timeout: 30_000 }, async () => {
    const before = await readFile(src('config.ts'), 'utf8');
    const result = await inlineField.run(session, { symbol: 'padding', class: 'Layout' });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics).toEqual([]);
    expect(result.value).toBe('10 - 4');

    // The read sat in the right operand of `-`, so the compiler's own
    // parenthesizer wraps it: `width - 10 - 4` would be a wrong answer
    // that compiles.
    expect(await preview(result.edit, src('page.ts'))).toContain('return width - (10 - 4);');
    const config = await preview(result.edit, src('config.ts'));
    expect(config).not.toContain('padding');
    expect(config).toContain('  readonly rows = 3;');
    // The JSDoc described the property and describes nothing without it.
    expect(config).not.toContain('Millimetres of padding');

    expect(await readFile(src('config.ts'), 'utf8')).toBe(before);
  });

  it('inlines a static field read through the class', { timeout: 30_000 }, async () => {
    const result = await inlineField.run(session, { symbol: 'VERSION', class: 'Layout' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('page.ts'))).toContain('return 2;');
    expect(await preview(result.edit, src('config.ts'))).not.toContain('VERSION');
  });

  it('inlines a private field read through this', { timeout: 30_000 }, async () => {
    const result = await inlineField.run(session, { symbol: 'seed', class: 'Layout' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('config.ts'))).toContain('    return 7;');
    // Private: no public-surface warning.
    expect(result.warnings).toEqual([]);
  });

  it('names the read sites it replaced', { timeout: 30_000 }, async () => {
    const result = await inlineField.run(session, { symbol: 'rows', class: 'Layout' });
    expect(result.readSites.map((site) => path.basename(site.file))).toEqual(['config.ts']);
  });
});

describe('ts/refactors/inline-field refusals', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('refuses a field that is assigned', async () => {
    await expect(inlineField.run(session, { symbol: 'mutable', class: 'Widget' })).rejects.toThrow(
      /assigned after it is initialized/,
    );
  });

  it('refuses an effectful initializer read more than once', async () => {
    await expect(inlineField.run(session, { symbol: 'ticket', class: 'Widget' })).rejects.toThrow(
      /could do something observable, and it is read 2 times/,
    );
  });

  it('refuses an initializer reading a variable assigned elsewhere', async () => {
    await expect(inlineField.run(session, { symbol: 'scaled', class: 'Widget' })).rejects.toThrow(
      /"scale", which is assigned elsewhere/,
    );
  });

  it('refuses an allocating initializer read more than once', async () => {
    await expect(inlineField.run(session, { symbol: 'tags', class: 'Widget' })).rejects.toThrow(
      /builds a new object every time/,
    );
  });

  it('refuses a this-reading initializer read through another object', async () => {
    // `other.me` would read the wrong instance, and it compiles.
    await expect(inlineField.run(session, { symbol: 'me', class: 'Widget' })).rejects.toThrow(
      /reads `this`, which means the instance it was declared on/,
    );
  });

  it('refuses an initializer whose names are not in scope at a read', async () => {
    // `BASE` is exported from the declaring module, but page.ts imports
    // only `Layout`. Substituting there would be TS2304 — the guard
    // would catch it, but the reason is clearer said up front.
    await expect(inlineField.run(session, { symbol: 'outer', class: 'Layout' })).rejects.toThrow(
      /"BASE" is not in scope there/,
    );
  });

  it('refuses a property-reading initializer read more than once', async () => {
    await expect(inlineField.run(session, { symbol: 'doubled', class: 'Widget' })).rejects.toThrow(
      /reads a property, which may hold something else by then/,
    );
  });

  it('refuses a property declared elsewhere in the hierarchy', async () => {
    await expect(inlineField.run(session, { symbol: 'kind', class: 'Derived' })).rejects.toThrow(
      /also declared on Base/,
    );
  });

  it('refuses a decorated property', async () => {
    await expect(inlineField.run(session, { symbol: 'level', class: 'Tracked' })).rejects.toThrow(
      /is decorated/,
    );
  });

  it('refuses a const binding, pointing at the tool that covers it', async () => {
    await expect(inlineField.run(session, { symbol: 'BASE' })).rejects.toThrow(
      /is not a class property — inline-variable/,
    );
  });
});

describe('ts/refactors/inline-field apply mode', () => {
  it('writes the edit and leaves the project compiling', { timeout: 60_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy) => {
      const result = await inlineField.run(copy, {
        symbol: 'padding',
        class: 'Layout',
        apply: true,
      });
      expect(result.applied).toBe(true);

      const reopened = TsProjectSession.open(copy.rootPath);
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
