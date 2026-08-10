import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { positionOf, preview, withProjectCopy } from '../testing.js';
import { safeDelete } from './safe-delete.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/safe-delete-ts');
const FORMATTING = path.join(FIXTURE, 'src/formatting.ts');
const APP = path.join(FIXTURE, 'src/app.ts');
const BARREL = path.join(FIXTURE, 'src/barrel.ts');
const COUNTER_TEST = path.join(FIXTURE, 'src/counter.test.ts');
const HANDLERS = path.join(FIXTURE, 'src/handlers.ts');
const HEADINGS = path.join(FIXTURE, 'src/headings.ts');
const LEGACY = path.join(FIXTURE, 'src/legacy.ts');
const LEGACY_TEST = path.join(FIXTURE, 'src/legacy.test.ts');
const ORPHAN = path.join(FIXTURE, 'src/orphan.ts');
const PAGES = path.join(FIXTURE, 'src/pages.ts');
const REEXPORTED = path.join(FIXTURE, 'src/reexported.ts');
const REPORT = path.join(FIXTURE, 'src/report.ts');

const SLUGIFY_ONLY = `export function slugify(title: string): string {
  return title.trim().toLowerCase().replace(/\\s+/g, '-');
}
`;

/** The message of the error a call rejects with. */
async function refusalOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the deletion to be refused');
}

describe('ts/refactors/safe-delete', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('deletes a dead export and everything it orphans', { timeout: 30_000 }, async () => {
    const before = await readFile(FORMATTING, 'utf8');
    const result = await safeDelete.run(session, { symbol: 'formatLabel' });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics).toEqual([]);
    expect(result.filesChanged).toEqual([APP, BARREL, FORMATTING, HEADINGS, PAGES]);
    expect(result.references.map((reference) => reference.kind).sort()).toEqual([
      'declaration',
      'export-specifier',
      'import-binding',
      'import-binding',
      'import-binding',
    ]);

    // One span, covering the JSDoc, the declaration, and the blank line
    // that separated it from what follows.
    expect(result.edit.changes[FORMATTING]).toHaveLength(1);
    expect(await preview(result.edit, FORMATTING)).toBe(SLUGIFY_ONLY);

    // The importers keep a valid statement, not a dangling comma —
    // whichever side of the list the dead name sat on.
    expect(await preview(result.edit, APP)).toBe(
      `import { slugify } from './formatting.js';\n` +
        `\n` +
        `export function pageId(title: string): string {\n` +
        `  return slugify(title);\n` +
        `}\n`,
    );
    expect(await preview(result.edit, PAGES)).toContain(
      `import { slugify } from './formatting.js';`,
    );

    // Its only binder: the whole import goes, and the blank line that
    // separates the import block from the code stays.
    expect(await preview(result.edit, HEADINGS)).toBe(
      `import { pageId } from './app.js';\n` +
        `\n` +
        `export function heading(title: string): string {\n` +
        `  return pageId(title);\n` +
        `}\n`,
    );

    // The barrel loses its whole re-export line, not just the name.
    expect(await preview(result.edit, BARREL)).toBe(
      `export { slugify } from './formatting.js';\n` +
        `export { dispatch } from './handlers.js';\n`,
    );

    expect(await readFile(FORMATTING, 'utf8')).toBe(before); // dry-run: disk untouched
  });

  it('reports blind spots when the only reference is a string key', { timeout: 30_000 }, async () => {
    const result = await safeDelete.run(session, { symbol: 'resetSession' });
    const literal = await positionOf(HANDLERS, "registry['resetSession']");

    // The compiler sees nothing wrong: registry['resetSession'] is not a
    // reference, so a clean guard is not a clean deletion.
    expect(result.newDiagnostics).toEqual([]);
    expect(result.references.map((reference) => reference.kind)).toEqual(['declaration']);
    expect(await preview(result.edit, HANDLERS)).not.toContain('function resetSession');

    const spots = result.blindSpots.join('\n');
    expect(result.blindSpots.length).toBeGreaterThan(0);
    expect(spots).toContain(`${HANDLERS}:${literal.line + 1}:`);
    expect(spots).toMatch(/string-keyed|string "resetSession"/i);
    expect(spots).toMatch(/exported/);
  });

  it('refuses a symbol that is still used, naming the site', { timeout: 30_000 }, async () => {
    const call = await positionOf(APP, 'slugify(title)');
    const message = await refusalOf(safeDelete.run(session, { symbol: 'slugify' }));

    expect(message).toContain('"slugify" is still used');
    expect(message).toContain(`${APP}:${call.line + 1}:`);
    expect(message).toContain('(direct-call)');
  });

  it('refuses a test-only symbol with includeTests, deletes it without', { timeout: 30_000 }, async () => {
    const kept = await refusalOf(
      safeDelete.run(session, { symbol: 'legacyStamp', includeTests: true }),
    );
    expect(kept).toContain(LEGACY_TEST);
    expect(kept).toContain('includeTests: false');

    const result = await safeDelete.run(session, { symbol: 'legacyStamp' });
    expect(result.newDiagnostics).toEqual([]);
    // Both files lose their last statement, so both files go.
    expect(result.edit.fileOps).toEqual([
      { kind: 'delete', file: LEGACY },
      { kind: 'delete', file: LEGACY_TEST },
    ]);
    expect(result.edit.changes).toEqual({});
    expect(result.warnings.join('\n')).toContain('src/legacy.test.ts');
    expect(result.warnings.join('\n')).toContain('includeTests: true');
  });

  it('keeps an emptied file that something still imports by path', { timeout: 30_000 }, async () => {
    // `import './orphan.js'` and `export * from './reexported.js'` name
    // no symbol, so no reference analysis can see them; deleting the
    // file anyway would compile in memory (the guard's overlay keeps it
    // resolvable) and fail on disk.
    for (const [symbol, file, importer] of [
      ['orphanTag', ORPHAN, 'src/preload.ts'],
      ['reexportedTag', REEXPORTED, 'src/all.ts'],
    ] as const) {
      const result = await safeDelete.run(session, { symbol });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.edit.fileOps).toBeUndefined();
      expect(await preview(result.edit, file)).toBe('');
      expect(result.warnings.join('\n')).toContain('still imports it by path');
      expect(result.warnings.join('\n')).toContain(importer);
    }
  });

  it('refuses a symbol a test does more than import', { timeout: 30_000 }, async () => {
    const use = await positionOf(COUNTER_TEST, 'tally([1, 2])');
    const message = await refusalOf(safeDelete.run(session, { symbol: 'tally' }));

    expect(message).toContain('used inside test bodies');
    expect(message).toContain(`${COUNTER_TEST}:${use.line + 1}:`);
    expect(message).toContain('delete the');
  });

  it('refuses a symbol exported from a package.json entry point', { timeout: 30_000 }, async () => {
    const message = await refusalOf(safeDelete.run(session, { symbol: 'main' }));

    expect(message).toContain('package.json');
    expect(message).toContain('bin["safe-delete-cli"]');
    expect(message).toContain('src/cli.ts');
  });

  it('deletes a dead class member without disturbing the class', { timeout: 30_000 }, async () => {
    const result = await safeDelete.run(session, { symbol: 'pad' });

    expect(result.newDiagnostics).toEqual([]);
    // A file-local symbol still carries the invisible-reference notes,
    // but not the API-break one an export gets.
    expect(result.blindSpots.length).toBeGreaterThan(0);
    expect(result.blindSpots.join('\n')).not.toContain('API break');
    expect(await preview(result.edit, REPORT)).toBe(
      `export class Report {\n` +
        `  constructor(protected readonly rows: string[]) {}\n` +
        `\n` +
        `  render(): string {\n` +
        `    return this.rows.join('\\n');\n` +
        `  }\n` +
        `}\n` +
        `\n` +
        `export class CsvReport extends Report {\n` +
        `  render(): string {\n` +
        `    return this.rows.join(',');\n` +
        `  }\n` +
        `}\n`,
    );
  });

  it('refuses a member another class overrides', { timeout: 30_000 }, async () => {
    const render = await positionOf(REPORT, 'render(): string');
    const message = await refusalOf(
      safeDelete.run(session, { file: REPORT, line: render.line, character: render.character }),
    );

    // Nothing calls either render, so the typecheck would have reported
    // no diagnostics at all: only the hierarchy makes this unsafe.
    expect(message).toContain('CsvReport');
    expect(message).toContain('which implementation runs');
  });

  it('refuses a parameter, pointing at change-signature', { timeout: 30_000 }, async () => {
    const message = await refusalOf(safeDelete.run(session, { symbol: 'argv' }));

    expect(message).toContain('is a parameter');
    expect(message).toContain('ts/refactors/change-signature');
  });
});

describe('ts/refactors/safe-delete apply mode', () => {
  it('writes the deletion and its orphan cleanup to disk', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (session, root) => {
      const result = await safeDelete.run(session, { symbol: 'formatLabel', apply: true });

      expect(result.applied).toBe(true);
      expect(result.newDiagnostics).toEqual([]);
      expect(await readFile(path.join(root, 'src/formatting.ts'), 'utf8')).toBe(SLUGIFY_ONLY);
      expect(await readFile(path.join(root, 'src/app.ts'), 'utf8')).toContain(
        `import { slugify } from './formatting.js';`,
      );
      expect(await readFile(path.join(root, 'src/barrel.ts'), 'utf8')).toBe(
        `export { slugify } from './formatting.js';\n` +
          `export { dispatch } from './handlers.js';\n`,
      );
    });
  });

  it('removes the files a deletion empties', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (session, root) => {
      const result = await safeDelete.run(session, { symbol: 'legacyStamp', apply: true });

      expect(result.applied).toBe(true);
      await expect(readFile(path.join(root, 'src/legacy.ts'), 'utf8')).rejects.toThrow(/ENOENT/);
      await expect(readFile(path.join(root, 'src/legacy.test.ts'), 'utf8')).rejects.toThrow(
        /ENOENT/,
      );
      // The session re-reads the project, so a second run sees the new tree.
      expect(session.sourceFiles().map((sf) => path.basename(sf.fileName))).not.toContain(
        'legacy.ts',
      );
    });
  });
});
