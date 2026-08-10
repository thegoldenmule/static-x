import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { moveFile } from './move-file.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/move-file-ts');

describe('ts/refactors/move-file', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('rewrites importers and the moved file itself', { timeout: 30_000 }, async () => {
    const oldFile = path.join(FIXTURE, 'src/lib.ts');
    const newFile = path.join(FIXTURE, 'src/core/lib.ts');
    const result = await moveFile.run(session, { file: 'src/lib.ts', toFile: 'src/core/lib.ts' });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics).toEqual([]);
    expect(result.edit.fileOps).toEqual([{ kind: 'rename', oldFile, newFile }]);

    // The importer gains a segment...
    expect(await preview(result.edit, path.join(FIXTURE, 'src/app.ts'))).toContain(
      "import { greet } from './core/lib.js'",
    );
    // ...and the moved file loses one.
    expect(await preview(result.edit, newFile)).toContain(
      "import { GREETING } from '../sibling.js'",
    );
    // Keyed by where the file will be, never by where it is.
    expect(Object.keys(result.edit.changes)).not.toContain(oldFile);
    expect(Object.keys(result.edit.changes)).toContain(newFile);

    // Dry run: neither the file nor the folder it would need is touched.
    expect(existsSync(oldFile)).toBe(true);
    expect(existsSync(path.join(FIXTURE, 'src/core'))).toBe(false);
  });

  it('accepts a destination folder and keeps the name', { timeout: 30_000 }, async () => {
    const result = await moveFile.run(session, { file: 'src/lib.ts', toDirectory: 'src/core' });
    expect(result.edit.fileOps).toEqual([
      {
        kind: 'rename',
        oldFile: path.join(FIXTURE, 'src/lib.ts'),
        newFile: path.join(FIXTURE, 'src/core/lib.ts'),
      },
    ]);
  });

  it('stays quiet about a paths alias the move stays inside', { timeout: 30_000 }, async () => {
    const result = await moveFile.run(session, {
      file: 'src/widgets/button.ts',
      toDirectory: 'src/widgets/inputs',
    });
    // "@widgets/*" still covers the destination, so there is nothing to say.
    expect(result.warnings).toEqual([]);
    expect(result.newDiagnostics).toEqual([]);
  });

  it('refuses moves it cannot make safely', { timeout: 30_000 }, async () => {
    await expect(moveFile.run(session, { file: 'src/lib.ts' })).rejects.toThrow(/Provide either/);
    await expect(
      moveFile.run(session, { file: 'src/lib.ts', toFile: 'src/x.ts', toDirectory: 'src' }),
    ).rejects.toThrow(/not both/);
    await expect(
      moveFile.run(session, { file: 'src/lib.ts', toFile: 'src/app.ts' }),
    ).rejects.toThrow(/already exists/);
    await expect(
      moveFile.run(session, { file: 'src/lib.ts', toDirectory: 'src' }),
    ).rejects.toThrow(/already where it would move to/);
    await expect(
      moveFile.run(session, { file: 'src/absent.ts', toFile: 'src/present.ts' }),
    ).rejects.toThrow(/not a file this project compiles/);
    await expect(
      moveFile.run(session, { file: 'src/lib.ts', toFile: '../escaped/lib.ts' }),
    ).rejects.toThrow(/outside the project/);
  });
});

describe('ts/refactors/move-file apply mode', () => {
  it('moves the file and leaves nothing behind', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (session, root) => {
      const result = await moveFile.run(session, {
        file: 'src/lib.ts',
        toDirectory: 'src/core',
        apply: true,
      });

      expect(result.applied).toBe(true);
      expect(result.newDiagnostics).toEqual([]);

      expect(await readFile(path.join(root, 'src/core/lib.ts'), 'utf8')).toContain(
        "from '../sibling.js'",
      );
      expect(await readFile(path.join(root, 'src/app.ts'), 'utf8')).toContain(
        "from './core/lib.js'",
      );
      // The moved file's own edits must not be written back to where it was.
      expect(existsSync(path.join(root, 'src/lib.ts'))).toBe(false);
      expect(await readdir(path.join(root, 'src'))).not.toContain('lib.ts');
    });
  });

  it('survives a rename that only changes case', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (session, root) => {
      const result = await moveFile.run(session, {
        file: 'src/Widget.ts',
        toFile: 'src/widget.ts',
        apply: true,
      });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.applied).toBe(true);

      // existsSync cannot tell the two spellings apart here; the
      // directory listing can.
      const entries = await readdir(path.join(root, 'src'));
      expect(entries).toContain('widget.ts');
      expect(entries).not.toContain('Widget.ts');
      expect(await readFile(path.join(root, 'src/widget.ts'), 'utf8')).toContain(
        'export function makeWidget',
      );
      expect(await readFile(path.join(root, 'src/app.ts'), 'utf8')).toContain(
        "from './widget.js'",
      );
    });
  });

  it('moves a file nothing imports, warning about the alias it leaves', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (session, root) => {
      const result = await moveFile.run(session, {
        file: 'src/widgets/button.ts',
        toFile: 'src/button.ts',
        apply: true,
      });

      // Nothing imports it and it imports nothing: the whole move is
      // the rename, with no specifier to rewrite anywhere.
      expect(result.edit.changes).toEqual({});
      expect(result.filesChanged).toEqual([
        path.join(root, 'src/button.ts'),
        path.join(root, 'src/widgets/button.ts'),
      ]);
      expect(result.applied).toBe(true);
      expect(await readFile(path.join(root, 'src/button.ts'), 'utf8')).toContain(
        "export const BUTTON = 'button'",
      );
      // TypeScript cannot rewrite a wildcard mapping the way it rewrites
      // one that names the file outright.
      expect(result.warnings.join('\n')).toContain('paths alias "@widgets/*"');
    });
  });

  it('warns about uncompiled references and moves anyway', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (session, root) => {
      const result = await moveFile.run(session, {
        file: 'src/cli.ts',
        toDirectory: 'src/tools',
        apply: true,
      });

      expect(result.applied).toBe(true);
      const warnings = result.warnings.join('\n');
      expect(warnings).toContain('package.json "bin.move-cli": "src/cli.ts"');
      expect(warnings).toContain('vitest.config.ts names "src/cli.ts"');
      // Neither file is rewritten by the move.
      expect(await readFile(path.join(root, 'package.json'), 'utf8')).toContain('src/cli.ts');
      expect(await readFile(path.join(root, 'vitest.config.ts'), 'utf8')).toContain('src/cli.ts');
      // The tsconfig alias naming the file outright is rewritten, so it
      // is not warned about.
      expect(await readFile(path.join(root, 'tsconfig.json'), 'utf8')).toContain('src/tools/cli.ts');
      expect(warnings).not.toContain('@cli');
      expect(await readFile(path.join(root, 'src/tools/cli.ts'), 'utf8')).toContain(
        "from '../app.js'",
      );
    });
  });
});
