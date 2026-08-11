import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { extractClass } from './extract-class.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/extract-class-ts');
const ORDER_TS = path.join(FIXTURE, 'src/order.ts');
const CONSUMER_TS = path.join(FIXTURE, 'src/consumer.ts');
const CRATE_TS = path.join(FIXTURE, 'src/crate.ts');
const MANIFEST_TS = path.join(FIXTURE, 'src/manifest.ts');
const GAUGE_TS = path.join(FIXTURE, 'src/gauge.ts');
const DIAL_TS = path.join(FIXTURE, 'src/dial.ts');
const LEDGER_TS = path.join(FIXTURE, 'src/ledger.ts');
const VAULT_TS = path.join(FIXTURE, 'src/vault.ts');
const PRICING_TS = path.join(FIXTURE, 'src/pricing.ts');

const PRICING = ['discountRate', 'taxRate', 'discountFor', 'taxFor'];

const PRICING_CLASS = `export class Pricing {
  /** Percentage taken off the subtotal. */
  discountRate = 0;

  /** Percentage added after the discount. */
  taxRate = 0;

  /** The amount the discount rate takes off \`amount\`. */
  discountFor(amount: Money): Money {
    return round((amount * this.discountRate) / 100);
  }

  /** The tax the tax rate adds to \`amount\`. */
  taxFor(amount: Money): Money {
    return round((amount * this.taxRate) / 100);
  }
}`;

/** The oracle the tool is built on, asked of a project read from disk. */
async function diagnosticsOfWrittenProject(root: string): Promise<string[]> {
  const reopened = TsProjectSession.open(root);
  try {
    const program = reopened.program();
    return program
      .getSourceFiles()
      .filter((sourceFile) => !sourceFile.isDeclarationFile)
      .flatMap((sourceFile) => [
        ...program.getSyntacticDiagnostics(sourceFile),
        ...program.getSemanticDiagnostics(sourceFile),
      ])
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
  } finally {
    await reopened.dispose();
  }
}

describe('ts/refactors/extract-class', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('moves the members and re-points what stays behind', { timeout: 60_000 }, async () => {
    const result = await extractClass.run(session, {
      symbol: 'Order',
      name: 'Pricing',
      members: PRICING,
    });

    expect(result.members).toEqual(PRICING);
    expect(result.newDiagnostics).toEqual([]);

    const text = await preview(result.edit, ORDER_TS);
    expect(text).toContain(PRICING_CLASS);
    // The field is the first member of the body, not where the first
    // moved member was: a field initializer runs in declaration order.
    expect(text).toContain(
      'export class Order {\n  private readonly pricing = new Pricing();\n\n  readonly id: string;',
    );
    // `total` stayed and reads two members that moved.
    expect(text).toContain(
      '  total(): Money {\n' +
        '    const net = this.subtotal() - this.pricing.discountFor(this.subtotal());\n' +
        '    return net + this.pricing.taxFor(net);\n' +
        '  }',
    );
    // The moved bodies keep naming their own state through `this`.
    expect(text).toContain('return round((amount * this.discountRate) / 100);');
  });

  it('stubs only the members with external uses', { timeout: 60_000 }, async () => {
    const result = await extractClass.run(session, {
      symbol: 'Order',
      name: 'Pricing',
      members: PRICING,
    });

    expect(
      result.externalUses.map(
        (use) => `${path.relative(FIXTURE, use.file)}:${use.line + 1}:${use.character + 1}`,
      ),
    ).toEqual(['src/consumer.ts:6:9', 'src/consumer.ts:12:16']);

    const text = await preview(result.edit, ORDER_TS);
    // discountRate is written from consumer.ts, so it keeps a get/set pair.
    expect(text).toContain(
      '  /** Percentage taken off the subtotal. */\n' +
        '  get discountRate(): number {\n' +
        '    return this.pricing.discountRate;\n' +
        '  }\n' +
        '\n' +
        '  set discountRate(value: number) {\n' +
        '    this.pricing.discountRate = value;\n' +
        '  }',
    );
    expect(text).toContain(
      '  /** The amount the discount rate takes off `amount`. */\n' +
        '  discountFor(amount: Money): Money {\n' +
        '    return this.pricing.discountFor(amount);\n' +
        '  }',
    );
    // taxRate and taxFor are only used through `this`, so no stub for them.
    expect(text).not.toContain('get taxRate()');
    expect(text).not.toContain('return this.pricing.taxFor(amount);');

    // Nothing outside the class changed: that is what delegate buys.
    expect(result.filesChanged).toEqual([ORDER_TS]);
    expect(result.warnings.join('\n')).toContain('no call site changed');
    expect(result.warnings.join('\n')).toContain(
      'A delegating stub for a data property is a get/set pair',
    );
  });

  it('rewrites every call site when delegate is off', { timeout: 60_000 }, async () => {
    const result = await extractClass.run(session, {
      symbol: 'Order',
      name: 'Pricing',
      members: PRICING,
      delegate: false,
    });

    expect(result.newDiagnostics).toEqual([]);
    const order = await preview(result.edit, ORDER_TS);
    // The field is public, and there are no stubs at all.
    expect(order).toContain('  readonly pricing = new Pricing();');
    expect(order).not.toContain('get discountRate()');

    const consumer = await preview(result.edit, CONSUMER_TS);
    expect(consumer).toContain('  order.pricing.discountRate = 10;');
    expect(consumer).toContain('  return order.pricing.discountFor(amount);');
    expect(result.warnings.join('\n')).toContain('The field "pricing" is public');
  });

  it('refuses delegate: false when a call site cannot be reached', { timeout: 60_000 }, async () => {
    // `const { tare } = crate` reads through a pattern, which no
    // `crate.packing.tare` rewrite can describe.
    await expect(
      extractClass.run(session, {
        symbol: 'Crate',
        name: 'Packing',
        members: ['tare', 'net'],
        delegate: false,
      }),
    ).rejects.toThrow(
      /delegate: false rewrites every external use[\s\S]*manifest\.ts:5:11 \(destructure-read[\s\S]*all-or-nothing/,
    );

    // The same split with stubs is fine, and leaves manifest.ts alone.
    const result = await extractClass.run(session, {
      symbol: 'Crate',
      name: 'Packing',
      members: ['tare', 'net'],
    });
    expect(result.newDiagnostics).toEqual([]);
    expect(result.filesChanged).toEqual([CRATE_TS]);
    const crate = await preview(result.edit, CRATE_TS);
    expect(crate).toContain('  fill({ net, tare }: { net: number; tare: number }): void {\n' +
      '    this.packing.net = net;\n' +
      '    this.packing.tare = tare;\n' +
      '  }');
    expect(crate).toContain('    return this.packing.tare + this.packing.net;');
    expect(await preview(result.edit, MANIFEST_TS)).toBe(await readFile(MANIFEST_TS, 'utf8'));
  });

  it('puts the new class in another module with its imports', { timeout: 60_000 }, async () => {
    const result = await extractClass.run(session, {
      symbol: 'Order',
      name: 'Pricing',
      members: PRICING,
      targetFile: 'src/pricing.ts',
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.edit.fileOps).toEqual([{ kind: 'create', file: PRICING_TS }]);
    expect(await preview(result.edit, PRICING_TS)).toBe(
      `import { type Money, round } from './money.js';\n\n${PRICING_CLASS}\n`,
    );

    const order = await preview(result.edit, ORDER_TS);
    expect(order).toContain("import { Pricing } from './pricing.js';");
    // `round` left with the moved code, so the class file stops binding
    // it — under noUnusedLocals an orphaned import is TS6133, which the
    // guard would report as a diagnostic this edit introduced.
    expect(order).toContain("import { type Money } from './money.js';");
    expect(order).not.toContain('round(');
  });

  it('appends to an existing destination module', { timeout: 60_000 }, async () => {
    // Two defects this case found. `Money` is declared in the
    // destination and imported into the class file, so the two symbols
    // wrapping it are distinct and an identity comparison reported the
    // name as meaning something else there. And the class file both
    // loses `round` from the money.js clause and gains `Pricing` on it,
    // which as two edits is one overlapping pair.
    const result = await extractClass.run(session, {
      symbol: 'Order',
      name: 'Pricing',
      members: PRICING,
      targetFile: 'src/money.ts',
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.edit.fileOps).toBeUndefined();
    const money = await preview(result.edit, path.join(FIXTURE, 'src/money.ts'));
    expect(money).toContain(`\n${PRICING_CLASS}\n`);
    expect(money).not.toContain('import');
    expect(await preview(result.edit, ORDER_TS)).toContain(
      "import { type Money, Pricing } from './money.js';",
    );
  });

  it('moves a get/set pair with the #private field behind it', { timeout: 60_000 }, async () => {
    const result = await extractClass.run(session, {
      symbol: 'Gauge',
      name: 'Reading',
      members: ['#level', 'level'],
    });

    expect(result.members).toEqual(['#level', 'level']);
    expect(result.newDiagnostics).toEqual([]);
    expect(
      result.externalUses.map(
        (use) => `${path.relative(FIXTURE, use.file)}:${use.line + 1}:${use.character + 1}`,
      ),
    ).toEqual(['src/dial.ts:5:9', 'src/dial.ts:5:23']);

    const text = await preview(result.edit, GAUGE_TS);
    // The #private field travels intact, because only members that
    // travel with it read it.
    expect(text).toContain(
      'export class Reading {\n' +
        '  #level = 0;\n' +
        '\n' +
        '  /** Reading, as a percentage. */\n' +
        '  get level(): number {\n' +
        '    return this.#level;\n' +
        '  }\n' +
        '\n' +
        '  set level(value: number) {\n' +
        '    this.#level = Math.max(0, Math.min(100, value));\n' +
        '  }\n' +
        '}',
    );
    // The stub is an accessor pair too, so dial.ts is untouched.
    expect(text).toContain(
      '  get level(): number {\n' +
        '    return this.reading.level;\n' +
        '  }\n' +
        '\n' +
        '  set level(value: number) {\n' +
        '    this.reading.level = value;\n' +
        '  }',
    );
    expect(text).toContain('    return `${this.reading.level}%`;');
    expect(await preview(result.edit, DIAL_TS)).toBe(await readFile(DIAL_TS, 'utf8'));
  });

  it('leaves a private member private when nothing outside reads it', { timeout: 60_000 }, async () => {
    const result = await extractClass.run(session, {
      symbol: 'Order',
      name: 'Lines',
      members: ['lines', 'add', 'subtotal'],
    });

    expect(result.externalUses).toEqual([]);
    expect(result.newDiagnostics).toEqual([]);
    const text = await preview(result.edit, ORDER_TS);
    expect(text).toContain('export class Lines {\n  private readonly lines: Line[] = [];');
    expect(text).toContain('const net = this.lines.subtotal() - this.discountFor(this.lines.subtotal());');
    expect(result.warnings.join('\n')).not.toContain('lost its accessibility modifier');
  });

  it('widens a private member the original still has to reach', { timeout: 60_000 }, async () => {
    // `lines` moves but `add` and `subtotal` stay, so they now read it
    // through the field — a read from a different class, where private
    // is TS2341 rather than a design.
    const result = await extractClass.run(session, {
      symbol: 'Order',
      name: 'Lines',
      members: ['lines'],
      field: 'held',
    });

    expect(result.newDiagnostics).toEqual([]);
    const text = await preview(result.edit, ORDER_TS);
    expect(text).toContain('export class Lines {\n  readonly lines: Line[] = [];\n}');
    expect(text).toContain('    this.held.lines.push({ sku, qty, unit });');
    expect(result.warnings.join('\n')).toContain(
      'lines (private) lost its accessibility modifier in Lines',
    );
  });

  it('empties a class cleanly when every member moves', { timeout: 60_000 }, async () => {
    const result = await extractClass.run(session, {
      symbol: 'Vault',
      name: 'Pin',
      members: ['check', '#pin', 'attempts'],
    });

    // Declaration order, not the order `members` listed them in.
    expect(result.members).toEqual(['#pin', 'attempts', 'check']);
    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, VAULT_TS)).toContain(
      'export class Vault {\n  private readonly pin = new Pin();\n}',
    );
  });

  it('refuses a split that cuts a dependency, naming both sides', { timeout: 60_000 }, async () => {
    await expect(
      extractClass.run(session, { symbol: 'Order', name: 'Totals', members: ['subtotal'] }),
    ).rejects.toThrow(
      /cuts a dependency: subtotal reads this\.lines[\s\S]*Either add "lines" to members/,
    );
  });

  it('refuses a #private member something left behind reads', { timeout: 60_000 }, async () => {
    await expect(
      extractClass.run(session, { symbol: 'Vault', name: 'Pin', members: ['#pin'] }),
    ).rejects.toThrow(
      /Vault\.#pin is a #private member[\s\S]*no this\.<field>\.#pin to rewrite those reads into/,
    );
  });

  it('refuses a member the hierarchy shares', { timeout: 60_000 }, async () => {
    await expect(
      extractClass.run(session, { symbol: 'DetailLedger', name: 'Formatting', members: ['format'] }),
    ).rejects.toThrow(/DetailLedger\.format is also declared by BaseLedger/);

    // A member the base does not declare moves out of the same class.
    const result = await extractClass.run(session, {
      symbol: 'DetailLedger',
      name: 'Labelling',
      members: ['label'],
    });
    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, LEDGER_TS)).toContain(
      'export class Labelling {\n' +
        '  /** Not shared, and touches nothing, so it moves on its own. */\n' +
        "  label = 'detail';\n" +
        '}',
    );
  });

  it('refuses the constructor and a static member', { timeout: 60_000 }, async () => {
    await expect(
      extractClass.run(session, { symbol: 'Order', name: 'Opening', members: ['constructor'] }),
    ).rejects.toThrow(/constructor initialises the whole object, not a subset/);

    await expect(
      extractClass.run(session, { symbol: 'Order', name: 'Opening', members: ['open'] }),
    ).rejects.toThrow(/Order\.open is static[\s\S]*ts\/refactors\/move-member/);
  });

  it('refuses a body no member-move can describe', { timeout: 60_000 }, async () => {
    await expect(
      extractClass.run(session, { symbol: 'Tally', name: 'Bumping', members: ['bump'] }),
    ).rejects.toThrow(/reads `this\[key\]` — a member reached through a computed key/);

    await expect(
      extractClass.run(session, { symbol: 'Tally', name: 'Selfie', members: ['self'] }),
    ).rejects.toThrow(/uses `this` as a value[\s\S]*rather than the Tally it is today/);

    await expect(
      extractClass.run(session, { symbol: 'DetailLedger', name: 'Plain', members: ['plain'] }),
    ).rejects.toThrow(/uses `super`[\s\S]*Plain does not extend it/);
  });

  it('refuses a stub it cannot write', { timeout: 60_000 }, async () => {
    // `fill({ net, tare })` binds its names inside the body, so a
    // delegating stub has nothing to forward.
    await expect(
      extractClass.run(session, {
        symbol: 'Crate',
        name: 'Packing',
        members: ['tare', 'net', 'fill'],
      }),
    ).rejects.toThrow(/takes a destructured parameter[\s\S]*Name the parameter, or run with delegate: false/);
  });

  it('refuses names it cannot resolve or cannot use', { timeout: 60_000 }, async () => {
    await expect(
      extractClass.run(session, { symbol: 'Order', name: 'Totals', members: ['chew'] }),
    ).rejects.toThrow(/no member named "chew"\. Available: id, lines, discountRate/);

    await expect(
      extractClass.run(session, { symbol: 'Order', name: 'Line', members: PRICING }),
    ).rejects.toThrow(/"Line" already means something else/);

    await expect(
      extractClass.run(session, { symbol: 'Order', name: 'Pricing', members: PRICING, field: 'id' }),
    ).rejects.toThrow(/Order already declares "id"/);

    await expect(
      extractClass.run(session, { symbol: 'Order', name: '2Legit', members: PRICING }),
    ).rejects.toThrow(/is not a legal class name/);

    await expect(
      extractClass.run(session, { symbol: 'Order', name: 'Totals', members: [] }),
    ).rejects.toThrow(/members must name at least one member/);

    await expect(
      extractClass.run(session, { symbol: 'discounted', name: 'X', members: ['a'] }),
    ).rejects.toThrow(/targets a class; the declaration here is a FunctionDeclaration/);
  });

  it('leaves the guard to catch what the analysis cannot', { timeout: 60_000 }, async () => {
    // `readonly id` has no initializer and is assigned by a constructor
    // that stays behind. Both halves are hard errors, and both land in
    // code this tool wrote — which is exactly what the guard is for.
    const result = await extractClass.run(session, {
      symbol: 'Order',
      name: 'Identity',
      members: ['id'],
      apply: true,
    });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics.join('\n')).toContain(
      "TS2564: Property 'id' has no initializer",
    );
    expect(result.newDiagnostics.join('\n')).toContain(
      "TS2540: Cannot assign to 'id' because it is a read-only property",
    );
    expect(await readFile(ORDER_TS, 'utf8')).not.toContain('class Identity');
  });

  it('warns about a computed key it cannot follow', { timeout: 60_000 }, async () => {
    const result = await extractClass.run(session, { symbol: 'Tally', name: 'Sum', members: ['total'] });
    expect(result.warnings.join('\n')).toContain('reads a member through a computed key (this[k])');
  });
});

describe('ts/refactors/extract-class apply mode', () => {
  it('writes the new class into a new module', { timeout: 120_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await extractClass.run(copy, {
        symbol: 'Order',
        name: 'Pricing',
        members: PRICING,
        targetFile: 'src/pricing.ts',
        apply: true,
      });

      expect(result.applied).toBe(true);
      expect(result.newDiagnostics).toEqual([]);
      expect(await readFile(path.join(root, 'src/pricing.ts'), 'utf8')).toBe(
        `import { type Money, round } from './money.js';\n\n${PRICING_CLASS}\n`,
      );
      expect(await readFile(path.join(root, 'src/consumer.ts'), 'utf8')).toBe(
        await readFile(CONSUMER_TS, 'utf8'),
      );

      expect(await diagnosticsOfWrittenProject(root)).toEqual([]);
    });
  });

  it('writes a call-site rewrite the whole project agrees with', { timeout: 120_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await extractClass.run(copy, {
        symbol: 'Gauge',
        name: 'Reading',
        members: ['#level', 'level'],
        delegate: false,
        apply: true,
      });

      expect(result.applied).toBe(true);
      expect(await readFile(path.join(root, 'src/dial.ts'), 'utf8')).toContain(
        '  gauge.reading.level = gauge.reading.level + 5;',
      );
      expect(await diagnosticsOfWrittenProject(root)).toEqual([]);
    });
  });
});

describe('ts/refactors/extract-class fixture is stable', () => {
  it('leaves the fixture untouched after dry runs', async () => {
    expect(await readFile(ORDER_TS, 'utf8')).toContain('export class Order {');
    expect(await readFile(ORDER_TS, 'utf8')).not.toContain('class Pricing');
    expect(await readFile(CONSUMER_TS, 'utf8')).toContain('  order.discountRate = 10;');
  });
});
