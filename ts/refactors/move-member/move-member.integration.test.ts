import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { moveMember } from './move-member.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/move-member-ts');
const src = (file: string) => path.join(FIXTURE, 'src', file);

describe('ts/refactors/move-member to another class', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('moves a static method and re-points every call', { timeout: 30_000 }, async () => {
    const before = await readFile(src('pricing.ts'), 'utf8');
    const result = await moveMember.run(session, {
      symbol: 'shipping',
      class: 'Pricing',
      toClass: 'Invoice',
    });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics).toEqual([]);

    const invoice = await preview(result.edit, src('invoice.ts'));
    expect(invoice).toContain('  /** Freight cost for a parcel, rounded to the cent. */\n');
    expect(invoice).toContain('  static shipping(weightKg: number): number {\n');
    expect(await preview(result.edit, src('pricing.ts'))).not.toContain('static shipping');

    expect(await preview(result.edit, src('checkout.ts'))).toContain(
      '${Pricing.label(currency)} ${Invoice.shipping(weightKg)}',
    );
    expect(await preview(result.edit, src('receipt.ts'))).toContain(
      'Invoice.shipping(weightKg),',
    );

    expect(result.references.map((reference) => path.basename(reference.file))).toEqual([
      'checkout.ts',
      'manifest.ts',
      'receipt.ts',
    ]);

    // Dry run: nothing on disk changed.
    expect(await readFile(src('pricing.ts'), 'utf8')).toBe(before);
  });

  it('carries the imports the moved code needs, and drops the ones it orphans', { timeout: 30_000 }, async () => {
    const result = await moveMember.run(session, {
      symbol: 'shipping',
      class: 'Pricing',
      toClass: 'Invoice',
    });

    // The body calls round2, which invoice.ts did not import.
    expect(await preview(result.edit, src('invoice.ts'))).toContain(
      "import { round2 } from './money.js';",
    );
    // manifest.ts named Pricing only to reach the member, and the
    // fixture compiles with noUnusedLocals — leaving the import behind
    // would be a TS6133 the guard refuses the whole move over.
    const manifest = await preview(result.edit, src('manifest.ts'));
    expect(manifest).not.toContain('Pricing');
    expect(manifest).toBe(
      "import { Invoice } from './invoice.js';\n" +
        '\n' +
        'export function manifestLine(weightKg: number): string {\n' +
        '  return `freight ${Invoice.shipping(weightKg)}`;\n' +
        '}\n',
    );
    // receipt.ts still reads Pricing.TAX_RATE, so its import stays.
    expect(await preview(result.edit, src('receipt.ts'))).toContain(
      "import { Pricing } from './pricing.js';",
    );
  });

  it('folds the destination into an import the file already has', { timeout: 30_000 }, async () => {
    // Draft is empty and lives beside Invoice, so the destination needs
    // no import of its own and receipt.ts, which already imports from
    // that module, grows a name rather than a statement.
    const result = await moveMember.run(session, { symbol: 'footer', toClass: 'Draft' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('invoice.ts'))).toBe(
      'export class Invoice {\n' +
        '  static header(): string {\n' +
        "    return 'INVOICE';\n" +
        '  }\n' +
        '}\n' +
        '\n' +
        'export class Draft {\n' +
        '  static footer(): string {\n' +
        "    return 'thank you';\n" +
        '  }\n' +
        '}\n',
    );
    const receipt = await preview(result.edit, src('receipt.ts'));
    expect(receipt).toContain("import { Invoice, Draft } from './invoice.js';");
    expect(receipt).toContain('Draft.footer(),');
  });
});

describe('ts/refactors/move-member to module scope', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('demotes a static method to an exported function', { timeout: 30_000 }, async () => {
    const result = await moveMember.run(session, {
      symbol: 'shipping',
      class: 'Pricing',
      toFile: 'src/freight.ts',
    });

    expect(result.newDiagnostics).toEqual([]);
    const freight = await preview(result.edit, src('freight.ts'));
    expect(freight).toContain("import { round2 } from './money.js';");
    expect(freight).toContain('/** Freight cost for a parcel, rounded to the cent. */\n');
    expect(freight).toContain('export function shipping(weightKg: number): number {\n');
    expect(freight).not.toContain('static');

    expect(await preview(result.edit, src('checkout.ts'))).toContain(
      '${Pricing.label(currency)} ${shipping(weightKg)}',
    );
    expect(await preview(result.edit, src('manifest.ts'))).toBe(
      "import { shipping } from './freight.js';\n" +
        '\n' +
        'export function manifestLine(weightKg: number): string {\n' +
        '  return `freight ${shipping(weightKg)}`;\n' +
        '}\n',
    );
  });

  it('demotes a static property to an exported const', { timeout: 30_000 }, async () => {
    const result = await moveMember.run(session, { symbol: 'TAX_RATE', toFile: 'src/freight.ts' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('freight.ts'))).toContain(
      'export const TAX_RATE = 0.2;',
    );
    // The class it left reads it too, so the rewrite reaches inside the
    // file that lost the member as well as the files that imported it.
    const pricing = await preview(result.edit, src('pricing.ts'));
    expect(pricing).toContain("import { TAX_RATE } from './freight.js';");
    expect(pricing).toContain('return round2(amount * TAX_RATE);');
    expect(pricing).not.toContain('static readonly TAX_RATE');
    expect(await preview(result.edit, src('receipt.ts'))).toContain('    TAX_RATE,\n');
  });

  it('carries a type-only dependency as a type-only import', { timeout: 30_000 }, async () => {
    const result = await moveMember.run(session, {
      symbol: 'volumetric',
      toFile: 'src/freight.ts',
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('freight.ts'))).toContain(
      "import type { Parcel } from './types.js';",
    );
    // Parcel was the only reason pricing.ts imported that module.
    expect(await preview(result.edit, src('pricing.ts'))).not.toContain('Parcel');
  });

  it('keeps the imports the member still needs when it stays in its file', { timeout: 30_000 }, async () => {
    // Demoting a member to module scope in the file it already lives in
    // relocates its text rather than removing it, and the relocated text
    // is raw source the pruning pass cannot see. Counting its names as
    // gone dropped `import type { Parcel }` and left a TS2304.
    const result = await moveMember.run(session, { symbol: 'volumetric', toFile: 'src/pricing.ts' });

    expect(result.newDiagnostics).toEqual([]);
    const pricing = await preview(result.edit, src('pricing.ts'));
    expect(pricing).toContain("import type { Parcel } from './types.js';");
    expect(pricing).toContain('export function volumetric(parcel: Parcel): number {');
    expect(pricing).not.toContain('static volumetric');
  });

  it('creates the destination module, in a directory that does not exist yet', { timeout: 30_000 }, async () => {
    const result = await moveMember.run(session, {
      symbol: 'shipping',
      class: 'Pricing',
      toFile: 'src/nowhere/ship.ts',
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.edit.fileOps).toEqual([{ kind: 'create', file: src('nowhere/ship.ts') }]);
    expect(await preview(result.edit, src('nowhere/ship.ts'))).toBe(
      "import { round2 } from '../money.js';\n" +
        '\n' +
        '/** Freight cost for a parcel, rounded to the cent. */\n' +
        'export function shipping(weightKg: number): number {\n' +
        '  return round2(weightKg * 1.5);\n' +
        '}\n',
    );
    expect(await preview(result.edit, src('checkout.ts'))).toContain(
      "import { shipping } from './nowhere/ship.js';",
    );
    await expect(stat(src('nowhere/ship.ts'))).rejects.toThrow();
  });

  it('hands a module-level binding to move-symbol', { timeout: 30_000 }, async () => {
    const result = await moveMember.run(session, { symbol: 'slugify', toFile: 'src/freight.ts' });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.warnings.join('\n')).toContain('ts/refactors/move-symbol');
    expect(await preview(result.edit, src('freight.ts'))).toContain('export function slugify');
    expect(await preview(result.edit, src('money.ts'))).not.toContain('export function slugify');
  });
});

describe('ts/refactors/move-member refusals', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('refuses an instance member', { timeout: 30_000 }, async () => {
    await expect(moveMember.run(session, { symbol: 'format', toClass: 'Invoice' })).rejects.toThrow(
      /instance member/,
    );
  });

  it('refuses a member that reads `this`', { timeout: 30_000 }, async () => {
    // `this` in a static is the class; on Invoice it would be Invoice,
    // and at module scope it would be nothing. Both compile.
    await expect(
      moveMember.run(session, { symbol: 'describe', toClass: 'Invoice' }),
    ).rejects.toThrow(/reads `this`/);
  });

  it('refuses a member that reads another static of its own class', { timeout: 30_000 }, async () => {
    await expect(moveMember.run(session, { symbol: 'tax', toClass: 'Invoice' })).rejects.toThrow(
      /reads Pricing\.TAX_RATE, which would stay behind/,
    );
  });

  it('refuses a member the hierarchy shares', { timeout: 30_000 }, async () => {
    await expect(moveMember.run(session, { symbol: 'title', toClass: 'Invoice' })).rejects.toThrow(
      /also declared by MonthlyReport/,
    );
  });

  it('refuses references the rewrite cannot describe', { timeout: 30_000 }, async () => {
    // Pricing['sku'] is a string key, and Discounted.label reaches the
    // member through a subclass. Both are real references the language
    // service reports and neither is an `A.m` this rewrite can re-point.
    await expect(moveMember.run(session, { symbol: 'sku', toClass: 'Invoice' })).rejects.toThrow(
      /Pricing\['sku'\]/,
    );
    await expect(moveMember.run(session, { symbol: 'label', toClass: 'Invoice' })).rejects.toThrow(
      /Discounted\.label/,
    );
  });

  it('refuses a demotion whose name is taken at a call site', { timeout: 30_000 }, async () => {
    // local.ts declares its own `netWeight`, so the unqualified call the
    // demotion writes would silently resolve to a string.
    await expect(
      moveMember.run(session, { symbol: 'netWeight', class: 'Pricing', toFile: 'src/freight.ts' }),
    ).rejects.toThrow(/"netWeight" already means something else at .*local\.ts/);
  });

  it('refuses a destination that already declares the name', { timeout: 30_000 }, async () => {
    await expect(
      moveMember.run(session, { symbol: 'shipping', class: 'Pricing', toClass: 'Ledger' }),
    ).rejects.toThrow(/Ledger already declares a member named "shipping"/);
  });

  it('refuses an ambiguous target, and takes `class` to settle it', { timeout: 30_000 }, async () => {
    await expect(moveMember.run(session, { symbol: 'shipping', toClass: 'Invoice' })).rejects.toThrow(
      /declared in multiple files/,
    );
    await expect(
      moveMember.run(session, { symbol: 'shipping', class: 'Nowhere', toClass: 'Invoice' }),
    ).rejects.toThrow(/No member named "shipping" is declared on class "Nowhere"/);
    const settled = await moveMember.run(session, {
      symbol: 'shipping',
      class: 'Pricing',
      toClass: 'Invoice',
    });
    expect(settled.newDiagnostics).toEqual([]);
  });

  it('refuses zero or two destinations', { timeout: 30_000 }, async () => {
    await expect(moveMember.run(session, { symbol: 'shipping', class: 'Pricing' })).rejects.toThrow(
      /exactly one destination/,
    );
    await expect(
      moveMember.run(session, {
        symbol: 'shipping',
        class: 'Pricing',
        toClass: 'Invoice',
        toFile: 'src/freight.ts',
      }),
    ).rejects.toThrow(/exactly one destination/);
  });

  it('refuses to put a module-level declaration on a class', { timeout: 30_000 }, async () => {
    await expect(moveMember.run(session, { symbol: 'slugify', toClass: 'Invoice' })).rejects.toThrow(
      /module-level declaration, not a class member/,
    );
  });

  it('refuses an edit the typecheck rejects', { timeout: 30_000 }, async () => {
    // A private static moved to another class is still private there,
    // so the class it left can no longer reach it. Nothing before the
    // edit knows that; the guard does.
    const result = await moveMember.run(session, {
      symbol: 'internalRate',
      toClass: 'Invoice',
      apply: true,
    });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics.join('\n')).toContain('TS2341');
    expect(result.warnings.join('\n')).toContain('is private');
    expect(await readFile(src('pricing.ts'), 'utf8')).toContain('private static internalRate');
  });
});

describe('ts/refactors/move-member apply mode', () => {
  it('writes the move to disk, leaving the project compiling', { timeout: 60_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const file = (name: string) => path.join(root, 'src', name);
      const result = await moveMember.run(copy, {
        symbol: 'shipping',
        class: 'Pricing',
        toFile: 'src/freight.ts',
        apply: true,
      });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.applied).toBe(true);
      expect(await readFile(file('freight.ts'), 'utf8')).toContain('export function shipping');
      expect(await readFile(file('pricing.ts'), 'utf8')).not.toContain('static shipping');
      expect(await readFile(file('checkout.ts'), 'utf8')).toContain('${shipping(weightKg)}');

      // An authored edit that merely looked right fails here: the whole
      // project is re-read from disk and typechecked from scratch.
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

      // The session must see the project as it now is: what was a class
      // member is now a module-level binding, which move-symbol owns.
      const again = await moveMember.run(copy, {
        symbol: 'shipping',
        file: 'freight.ts',
        toFile: 'src/money.ts',
      });
      expect(again.newDiagnostics).toEqual([]);
      expect(again.warnings.join('\n')).toContain('ts/refactors/move-symbol');
    });
  });
});
