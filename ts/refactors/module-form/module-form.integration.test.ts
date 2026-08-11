import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { moduleForm } from './module-form.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/module-form-ts');
const src = (file: string) => path.join(FIXTURE, 'src', file);

const session = TsProjectSession.open(FIXTURE);
afterAll(() => session.dispose());

describe('ts/refactors/module-form', () => {
  it('converts a default export and rewrites every importer', { timeout: 30_000 }, async () => {
    const result = await moduleForm.run(session, {
      file: 'src/greet.ts',
      symbol: 'greet',
      to: 'named-export',
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('greet.ts'))).toContain('export function greet(');
    // Both importers, in files a caller looking at greet.ts never opened.
    for (const importer of ['app.ts', 'other.ts']) {
      expect(await preview(result.edit, src(importer)), importer).toContain(
        "import { greet } from './greet.js';",
      );
    }
  });

  it('converts a namespace import, rewriting every member access', { timeout: 30_000 }, async () => {
    const result = await moduleForm.run(session, {
      file: 'src/app.ts',
      module: './tone.js',
      to: 'named-imports',
    });

    expect(result.newDiagnostics).toEqual([]);
    const app = await preview(result.edit, src('app.ts'));
    expect(app).toContain("import { shout, LOUD } from './tone.js';");
    // The clause is the easy half; every qualified use has to move too.
    expect(app).toContain("shout('hey')");
    expect(app).not.toContain('tone.shout');
    expect(app).not.toContain('tone.LOUD');
  });

  it('refuses a conversion TypeScript does not offer there', { timeout: 30_000 }, async () => {
    // The engine re-derives its own target and dispatches on that, so
    // an unlisted action would perform a different conversion rather
    // than refuse. Asking for a named-import conversion of a namespace
    // import must not silently do something else.
    await expect(
      moduleForm.run(session, { file: 'src/app.ts', module: './tone.js', to: 'default-import' }),
    ).rejects.toThrow(/does not offer/);
  });

  it('reports which import it could not find', { timeout: 30_000 }, async () => {
    await expect(
      moduleForm.run(session, { file: 'src/app.ts', module: './nowhere.js', to: 'named-imports' }),
    ).rejects.toThrow(/no import from "\.\/nowhere\.js".*it imports from/s);
  });

  it('requires the input the chosen form needs', { timeout: 30_000 }, async () => {
    await expect(
      moduleForm.run(session, { file: 'src/greet.ts', to: 'named-export' }),
    ).rejects.toThrow(/needs "symbol"/);
    await expect(
      moduleForm.run(session, { file: 'src/app.ts', to: 'named-imports' }),
    ).rejects.toThrow(/needs "module"/);
  });

  it('writes the conversion to disk, leaving the project compiling', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await moduleForm.run(copy, {
        file: 'src/greet.ts',
        symbol: 'greet',
        to: 'named-export',
        apply: true,
      });

      expect(result.applied).toBe(true);
      expect(await readFile(path.join(root, 'src/other.ts'), 'utf8')).toContain(
        "import { greet } from './greet.js';",
      );

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
