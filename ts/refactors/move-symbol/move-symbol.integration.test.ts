import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { moveSymbol } from './move-symbol.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/move-symbol-ts');
const src = (file: string) => path.join(FIXTURE, 'src', file);

describe('ts/refactors/move-symbol', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('moves a symbol to a new file and repoints every importer', { timeout: 30_000 }, async () => {
    const before = await readFile(src('models.ts'), 'utf8');
    const result = await moveSymbol.run(session, { symbol: 'Shipment' });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics).toEqual([]);
    expect(result.created).toEqual([src('Shipment.ts')]);
    expect(result.edit.fileOps).toEqual([{ kind: 'create', file: src('Shipment.ts') }]);

    expect(await preview(result.edit, src('Shipment.ts'))).toContain('export interface Shipment {');
    const models = await preview(result.edit, src('models.ts'));
    expect(models).not.toContain('export interface Shipment');
    // models still uses the type, so it imports what it used to declare.
    expect(models).toContain("import { Shipment } from './Shipment.js';");

    expect(await preview(result.edit, src('warehouse.ts'))).toContain(
      "import { Shipment } from './Shipment.js';",
    );
    expect(await preview(result.edit, src('report.ts'))).toContain(
      "import { Shipment } from './Shipment.js';",
    );

    // Dry run: nothing on disk moved.
    expect(await readFile(src('models.ts'), 'utf8')).toBe(before);
    await expect(stat(src('Shipment.ts'))).rejects.toThrow();
  });

  it('reports which existing files it could have moved into', { timeout: 30_000 }, async () => {
    const result = await moveSymbol.run(session, { symbol: 'Shipment' });
    expect(result.destinationSuggestions).toContain(src('inventory.ts'));
    expect(result.destinationSuggestions).not.toContain(src('models.ts'));
  });

  it('refuses a move whose created file would not compile', { timeout: 30_000 }, async () => {
    // billableWeight calls `round`, destructured from Math at the top of
    // models.ts. TypeScript's usage analysis skips destructured locals,
    // so the helper neither travels nor gets imported.
    const result = await moveSymbol.run(session, { symbol: 'billableWeight', apply: true });

    expect(result.applied).toBe(false);
    expect(result.created).toEqual([src('billableWeight.ts')]);
    expect(result.newDiagnostics.join('\n')).toContain("TS2304: Cannot find name 'round'.");
    expect(await preview(result.edit, src('billableWeight.ts'))).toContain('round(shipment.weightKg');
    await expect(stat(src('billableWeight.ts'))).rejects.toThrow();
  });

  it('moves a symbol into an existing file', { timeout: 30_000 }, async () => {
    const result = await moveSymbol.run(session, { symbol: 'Shipment', toFile: 'src/inventory.ts' });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.destinationSuggestions).toEqual([]);

    const inventory = await preview(result.edit, src('inventory.ts'));
    expect(inventory).toContain('export interface Shipment {');
    expect(inventory).toContain("export const WAREHOUSE_ID = 'W-1';");
    for (const importer of ['warehouse.ts', 'report.ts']) {
      expect(await preview(result.edit, src(importer))).toContain(
        "import { Shipment } from './inventory.js';",
      );
    }
  });

  it('redirects barrel re-exports of the moved symbol', { timeout: 30_000 }, async () => {
    // A named re-export sharing its statement with a name that stays:
    // the statement splits so each half points at the right module.
    const split = await moveSymbol.run(session, { symbol: 'Shipment', toFile: 'src/inventory.ts' });
    const barrel = await preview(split.edit, src('index.ts'));
    expect(barrel).toContain("export { Carrier } from './models.js';");
    expect(barrel).toContain("export { Shipment } from './inventory.js';");
    expect(barrel).toContain("export { byKey } from './warehouse.js';");
    expect(split.newDiagnostics).toEqual([]);

    // A re-export naming only the moved symbol: the specifier moves.
    const specifierOnly = await moveSymbol.run(session, {
      symbol: 'billableWeight',
      toFile: 'src/inventory.ts',
    });
    expect(await preview(specifierOnly.edit, src('index.ts'))).toContain(
      "export { billableWeight } from './inventory.js';",
    );
  });

  it('redirects a re-export in a file the engine also edited', { timeout: 30_000 }, async () => {
    // facade.ts both imports Shipment and re-exports it from the same
    // module. The engine rewrites the import and leaves the re-export
    // pointing at a module that no longer declares the symbol, so
    // skipping the whole file because the engine touched part of it
    // leaves exactly the broken re-export this pass exists to repair.
    // Found on a real 320-file package, where it made types re-exported
    // this way unmovable.
    const result = await moveSymbol.run(session, {
      symbol: 'Shipment',
      toFile: 'src/inventory.ts',
    });

    expect(result.newDiagnostics).toEqual([]);
    const facade = await preview(result.edit, src('facade.ts'));
    expect(facade).toContain("export type { Carrier } from './models.js';");
    expect(facade).toContain("export type { Shipment } from './inventory.js';");
    // The engine's own edit to the import clause is left alone.
    expect(facade).toContain("import type { Shipment } from './inventory.js';");
  });

  it('warns about an export * that can no longer carry the symbol', { timeout: 30_000 }, async () => {
    const result = await moveSymbol.run(session, { symbol: 'Shipment', toFile: 'src/inventory.ts' });
    expect(result.warnings.join('\n')).toContain(src('api.ts'));
    expect(result.warnings.join('\n')).toContain('"Shipment"');
    // A warning is not a diagnostic: it does not block the move.
    expect(result.newDiagnostics).toEqual([]);
    expect(result.filesChanged).not.toContain(src('api.ts'));
  });

  it('refuses a destination that already imports the symbol', { timeout: 30_000 }, async () => {
    // keys.ts imports shipmentKey and nothing else from models, so the
    // engine has to delete and extend the same import statement.
    await expect(
      moveSymbol.run(session, { symbol: 'shipmentKey', toFile: 'src/keys.ts' }),
    ).rejects.toThrow(/keys\.ts already imports "shipmentKey"/);
  });

  it('moves into a directory that does not exist yet', { timeout: 30_000 }, async () => {
    // Module resolution probes for the containing directory before the
    // file, so every rewritten importer used to fail the guard with a
    // bogus TS2307 against an edit that was in fact correct.
    const result = await moveSymbol.run(session, {
      symbol: 'Shipment',
      toFile: 'src/nowhere/models.ts',
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.created).toContain(path.join(FIXTURE, 'src/nowhere/models.ts'));
  });

  it('refuses targets it cannot address', { timeout: 30_000 }, async () => {
    await expect(
      moveSymbol.run(session, { symbol: 'Shipment', toFile: 'src/models.ts' }),
    ).rejects.toThrow(/already lives in/);
    await expect(moveSymbol.run(session, { symbol: 'weightKg' })).rejects.toThrow(
      /not a top-level declaration/,
    );
    await expect(moveSymbol.run(session, { symbol: 'nothingHere' })).rejects.toThrow(
      /No declaration named/,
    );
  });
});

describe('ts/refactors/move-symbol apply mode', () => {
  it('writes the move to disk in a copied project', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (session, root) => {
      const file = (name: string) => path.join(root, 'src', name);
      const result = await moveSymbol.run(session, {
        symbol: 'Shipment',
        toFile: 'src/shipment.ts',
        apply: true,
      });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.applied).toBe(true);
      expect(result.created).toEqual([file('shipment.ts')]);

      expect(await readFile(file('shipment.ts'), 'utf8')).toContain('export interface Shipment {');
      expect(await readFile(file('models.ts'), 'utf8')).not.toContain('export interface Shipment');
      expect(await readFile(file('warehouse.ts'), 'utf8')).toContain(
        "import { Shipment } from './shipment.js';",
      );
      expect(await readFile(file('index.ts'), 'utf8')).toContain(
        "export { Shipment } from './shipment.js';",
      );

      // The session must see the project as it now is: moving the
      // symbol back finds it in its new home.
      const back = await moveSymbol.run(session, {
        symbol: 'Shipment',
        toFile: 'src/models.ts',
      });
      expect(back.newDiagnostics).toEqual([]);
      expect(back.filesChanged).toContain(file('models.ts'));
    });
  });
});
