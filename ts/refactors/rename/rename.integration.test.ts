import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyTextEdits } from '../../../core/edits/index.js';
import { TsProjectSession } from '../../project/index.js';
import { rename } from './rename.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/rename-ts');
const CONFIG_TS = path.join(FIXTURE, 'src/config.ts');
const CONSUMER_TS = path.join(FIXTURE, 'src/consumer.ts');

async function positionOf(filePath: string, needle: string) {
  const lines = (await readFile(filePath, 'utf8')).split('\n');
  for (const [line, text] of lines.entries()) {
    const character = text.indexOf(needle);
    if (character !== -1) return { line, character };
  }
  throw new Error(`"${needle}" not found in ${filePath}`);
}

async function preview(edit: { changes: Record<string, { range: never; newText: string }[]> }, file: string) {
  return applyTextEdits(await readFile(file, 'utf8'), edit.changes[file] ?? []);
}

describe('ts/refactors/rename', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('dry-runs a cross-file property rename with shorthand expansion', { timeout: 30_000 }, async () => {
    const before = await readFile(CONFIG_TS, 'utf8');
    const { line, character } = await positionOf(CONFIG_TS, 'retries: number');
    const result = await rename.run(session, {
      newName: 'attempts',
      file: CONFIG_TS,
      line,
      character,
    });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics).toEqual([]);
    expect(Object.keys(result.edit.changes).sort()).toEqual([CONFIG_TS, CONSUMER_TS]);

    const config = await preview(result.edit as never, CONFIG_TS);
    expect(config).toContain('attempts: number');
    // Shorthand `{ retries }` must expand, keeping the parameter intact.
    expect(config).toContain('{ attempts: retries }');
    expect(config).toContain('makeOptions(retries: number)');
    expect(await preview(result.edit as never, CONSUMER_TS)).toContain('options.attempts');

    expect(await readFile(CONFIG_TS, 'utf8')).toBe(before); // dry-run: disk untouched
  });

  it('resolves the target from a declaration name', { timeout: 30_000 }, async () => {
    const result = await rename.run(session, { newName: 'buildOptions', symbol: 'makeOptions' });
    expect(result.applied).toBe(false);
    expect(Object.keys(result.edit.changes).sort()).toEqual([CONFIG_TS, CONSUMER_TS]);
    expect(await preview(result.edit as never, CONSUMER_TS)).toContain(
      "import { buildOptions } from './config.js'",
    );
  });

  it('refuses a rename that would introduce a collision', { timeout: 30_000 }, async () => {
    const before = await readFile(CONSUMER_TS, 'utf8');
    const result = await rename.run(session, {
      newName: 'totalRetries', // collides with the function in consumer.ts
      symbol: 'makeOptions',
      apply: true,
    });
    expect(result.applied).toBe(false);
    expect(result.newDiagnostics.length).toBeGreaterThan(0);
    expect(result.newDiagnostics.join('\n')).toMatch(/totalRetries|[Dd]uplicate/);
    expect(await readFile(CONSUMER_TS, 'utf8')).toBe(before); // refused: disk untouched
  });

  it('rejects invalid identifiers and missing targets', async () => {
    await expect(rename.run(session, { newName: 'not a name', symbol: 'makeOptions' })).rejects.toThrow(
      /not a valid identifier/,
    );
    await expect(rename.run(session, { newName: 'x', symbol: 'doesNotExist' })).rejects.toThrow(
      /No declaration named/,
    );
    await expect(rename.run(session, { newName: 'x' })).rejects.toThrow(/Provide either/);
  });
});

describe('ts/refactors/rename apply mode', () => {
  it('writes the rename to disk in a copied project', { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'static-x-rename-'));
    await cp(FIXTURE, dir, { recursive: true });
    const copy = TsProjectSession.open(dir);
    try {
      const configPath = path.join(dir, 'src/config.ts');
      const { line, character } = await positionOf(configPath, 'retries: number');
      const result = await rename.run(copy, {
        newName: 'attempts',
        file: configPath,
        line,
        character,
        apply: true,
      });

      expect(result.applied).toBe(true);
      expect(result.newDiagnostics).toEqual([]);
      const config = await readFile(configPath, 'utf8');
      expect(config).toContain('attempts: number');
      expect(config).toContain('{ attempts: retries }');
      expect(await readFile(path.join(dir, 'src/consumer.ts'), 'utf8')).toContain(
        'options.attempts',
      );
    } finally {
      await copy.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
