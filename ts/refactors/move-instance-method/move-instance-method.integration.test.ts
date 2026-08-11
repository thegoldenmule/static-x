import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { moveInstanceMethod } from './move-instance-method.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/move-instance-method-ts');
const src = (file: string) => path.join(FIXTURE, 'src', file);

describe('ts/refactors/move-instance-method onto a parameter type', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('flips the receiver at the declaration and every call', { timeout: 30_000 }, async () => {
    const before = await readFile(src('order.ts'), 'utf8');
    const result = await moveInstanceMethod.run(session, {
      symbol: 'bill',
      class: 'Order',
      to: 'invoice',
    });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics).toEqual([]);

    // `this` became `order`, `invoice` became `this`, and the parameter
    // that used to carry the destination now carries the old receiver.
    expect(await preview(result.edit, src('invoice.ts'))).toContain(
      '  /** Charge this order to an invoice. */\n' +
        '  bill(order: Order, note: string): number {\n' +
        '    const amount = round2(order.quantity * order.unitPrice);\n' +
        '    this.total += amount;\n' +
        '    this.add(`${order.sku} ${note}`);\n' +
        '    return amount;\n' +
        '  }\n',
    );
    expect(await preview(result.edit, src('order.ts'))).not.toContain('bill(');

    // `a.m(b, c)` becomes `b.m(a, c)` — the argument order changes, not
    // just the receiver.
    expect(await preview(result.edit, src('checkout.ts'))).toContain(
      "const amount = invoice.bill(order, 'rush');",
    );
    expect(await preview(result.edit, src('report.ts'))).toContain(
      "sum += invoice.bill(order, 'batch');",
    );

    expect(
      result.callSites.map((site) => `${path.basename(site.file)}:${site.line + 1}`),
    ).toEqual(['checkout.ts:8', 'report.ts:11']);

    // Dry run: nothing on disk changed.
    expect(await readFile(src('order.ts'), 'utf8')).toBe(before);
  });

  it('carries the imports the moved body needs, and drops the orphans', { timeout: 30_000 }, async () => {
    const result = await moveInstanceMethod.run(session, {
      symbol: 'bill',
      class: 'Order',
      to: 'invoice',
    });

    const invoice = await preview(result.edit, src('invoice.ts'));
    // The body calls round2, which invoice.ts did not import.
    expect(invoice).toContain("import { round2 } from './money.js';");
    // The receiver parameter is an annotation, so a value import here
    // would close a runtime cycle: order.ts imports invoice.ts today.
    expect(invoice).toContain("import type { Order } from './order.js';");

    const order = await preview(result.edit, src('order.ts'));
    // round2 was only ever used by the method that left, but `pad` came
    // from the same module and stays — so the clause is rebuilt rather
    // than deleted. Under noUnusedLocals the orphan would be a TS6133
    // the guard attributes to this edit, refusing the whole move.
    expect(order).toContain("import { pad } from './money.js';");
    expect(order).not.toContain('round2');
  });

  it('maps the argument through the resolved signature, not by position', { timeout: 30_000 }, async () => {
    // `transfer(note, invoice)` puts the destination second, so the flip
    // moves argument 2 left of the dot and the old receiver takes slot 1.
    // Counting commas would have moved the note.
    const result = await moveInstanceMethod.run(session, { symbol: 'transfer', to: 'invoice' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('invoice.ts'))).toContain(
      '  transfer(order: Order, note: string): string {\n' +
        '    this.add(note);\n' +
        '    return `${order.sku}->${note}`;\n' +
        '  }\n',
    );
    expect(await preview(result.edit, src('checkout.ts'))).toContain(
      '  invoice.transfer(\n    order, \'shipped\',\n  );\n',
    );
    // The receiver overtakes an argument, and a property read among the
    // ones it passes would run a getter earlier than it does today.
    expect(result.warnings.join('\n')).toContain('passes the new receiver as argument 2');
  });

  it('adds no parameter when the body never reads the receiver', { timeout: 30_000 }, async () => {
    const result = await moveInstanceMethod.run(session, { symbol: 'stampOn', to: 'invoice' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('invoice.ts'))).toContain(
      '  stampOn(note: string): void {\n    this.add(`stamp ${note}`);\n  }\n',
    );
    // Nothing to pass, so the argument is dropped rather than moved.
    expect(await preview(result.edit, src('checkout.ts'))).toContain(
      "  invoice.stampOn('packed');\n",
    );
  });
});

describe('ts/refactors/move-instance-method onto a field type', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('folds `this.field` into `this` and routes call sites through the field', { timeout: 30_000 }, async () => {
    const result = await moveInstanceMethod.run(session, {
      symbol: 'render',
      class: 'Receipt',
      to: 'printer',
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('printer.ts'))).toContain(
      '  /** Formats through the printer it holds — feature envy on Printer. */\n' +
        '  render(receipt: Receipt, width: number): string {\n' +
        '    return this.wrap(`${receipt.id} ${round2(receipt.amount)}`).padEnd(width);\n' +
        '  }\n',
    );
    // `a.m(c)` becomes `a.f.m(a, c)`: the field is how the call reaches
    // the class that now owns the method.
    expect(await preview(result.edit, src('checkout.ts'))).toContain(
      '${receipt.printer.render(receipt, 24)}',
    );
    expect(await preview(result.edit, src('receipt.ts'))).not.toContain('round2');
  });

  it('takes a field declared as a constructor parameter property', { timeout: 30_000 }, async () => {
    const result = await moveInstanceMethod.run(session, { symbol: 'slip', to: 'printer' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('printer.ts'))).toContain(
      '  slip(shipment: Shipment): string {\n    return this.wrap(shipment.tracking);\n  }\n',
    );
    expect(await preview(result.edit, src('shipment.ts'))).toContain(
      'return shipment.printer.slip(shipment);',
    );
  });
});

describe('ts/refactors/move-instance-method keepDelegate', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('leaves a delegate behind and touches no call site', { timeout: 30_000 }, async () => {
    const result = await moveInstanceMethod.run(session, {
      symbol: 'bill',
      class: 'Order',
      to: 'invoice',
      keepDelegate: true,
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.callSites).toEqual([]);
    expect(await preview(result.edit, src('order.ts'))).toContain(
      '  /** Charge this order to an invoice. */\n' +
        '  bill(invoice: Invoice, note: string): number {\n' +
        '    return invoice.bill(this, note);\n' +
        '  }\n',
    );
    // The delegate keeps the old signature, so callers are untouched.
    expect(await preview(result.edit, src('checkout.ts'))).toContain(
      "const amount = order.bill(invoice, 'rush');",
    );
    expect(result.filesChanged.map((file) => path.basename(file)).sort()).toEqual([
      'invoice.ts',
      'order.ts',
    ]);
  });

  it('moves a method that escapes as a value, which the plain form refuses', { timeout: 30_000 }, async () => {
    await expect(
      moveInstanceMethod.run(session, { symbol: 'summarize', to: 'invoice' }),
    ).rejects.toThrow(/is not only called/);

    const kept = await moveInstanceMethod.run(session, {
      symbol: 'summarize',
      to: 'invoice',
      keepDelegate: true,
    });
    expect(kept.newDiagnostics).toEqual([]);
    expect(await preview(kept.edit, src('order.ts'))).toContain(
      '    return invoice.summarize(this);\n',
    );
  });
});

describe('ts/refactors/move-instance-method refusals', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('refuses a `to` whose type is not a class it can write to', { timeout: 30_000 }, async () => {
    await expect(
      moveInstanceMethod.run(session, { symbol: 'labelFor', to: 'width' }),
    ).rejects.toThrow(/typed `number`, which is not a class/);
    await expect(
      moveInstanceMethod.run(session, { symbol: 'dueUnder', to: 'terms' }),
    ).rejects.toThrow(/An interface holds no implementations/);
  });

  it('refuses a `to` that names nothing', { timeout: 30_000 }, async () => {
    await expect(
      moveInstanceMethod.run(session, { symbol: 'bill', class: 'Order', to: 'nope' }),
    ).rejects.toThrow(/neither a parameter of Order.bill nor a field of Order/);
  });

  it('refuses a method the hierarchy shares', { timeout: 30_000 }, async () => {
    await expect(
      moveInstanceMethod.run(session, { symbol: 'settle', class: 'Quote', to: 'invoice' }),
    ).rejects.toThrow(/also declared by Draft/);
  });

  it('refuses a body that reads `super`', { timeout: 30_000 }, async () => {
    await expect(
      moveInstanceMethod.run(session, { symbol: 'attach', to: 'invoice' }),
    ).rejects.toThrow(/reads `super`/);
  });

  it('refuses an overload set', { timeout: 30_000 }, async () => {
    await expect(moveInstanceMethod.run(session, { symbol: 'tag', to: 'invoice' })).rejects.toThrow(
      /is an overload set/,
    );
  });

  it('refuses a destination that already declares the name', { timeout: 30_000 }, async () => {
    await expect(
      moveInstanceMethod.run(session, { symbol: 'record', class: 'Order', to: 'ledger' }),
    ).rejects.toThrow(/Ledger already declares a member named "record"/);
  });

  it('refuses a body reading a member the destination cannot see', { timeout: 30_000 }, async () => {
    // `this.channel` becomes `order.channel`, and `channel` is private
    // to Order. The compiler would say so, but from generated text.
    await expect(
      moveInstanceMethod.run(session, { symbol: 'auditTo', to: 'invoice' }),
    ).rejects.toThrow(/reads private Order.channel/);
  });

  it('refuses a receiver that does work, since the flip reorders it', { timeout: 30_000 }, async () => {
    await expect(
      moveInstanceMethod.run(session, { symbol: 'charge', to: 'invoice' }),
    ).rejects.toThrow(/is made on `makeOrder\(\)`, which does work/);
  });

  it('refuses a call that omits the destination argument', { timeout: 30_000 }, async () => {
    await expect(
      moveInstanceMethod.run(session, { symbol: 'annotate', to: 'invoice' }),
    ).rejects.toThrow(/omits "invoice", so there is no receiver to move/);
  });

  it('refuses a recursive method', { timeout: 30_000 }, async () => {
    await expect(
      moveInstanceMethod.run(session, { symbol: 'chain', to: 'invoice' }),
    ).rejects.toThrow(/calls itself/);
  });

  it('refuses a private destination field', { timeout: 30_000 }, async () => {
    await expect(
      moveInstanceMethod.run(session, { symbol: 'emboss', to: 'stamp' }),
    ).rejects.toThrow(/Receipt.stamp is private/);
  });

  it('refuses an ambiguous target, and takes `class` to settle it', { timeout: 30_000 }, async () => {
    await expect(moveInstanceMethod.run(session, { symbol: 'record', to: 'ledger' })).rejects.toThrow(
      /declared in multiple files/,
    );
    await expect(
      moveInstanceMethod.run(session, { symbol: 'bill', class: 'Nowhere', to: 'invoice' }),
    ).rejects.toThrow(/No member named "bill" is declared on class "Nowhere"/);
  });

  it('refuses an edit the typecheck rejects', { timeout: 30_000 }, async () => {
    // A private method moved onto another class is private *there*, so
    // the class it left can no longer call it. Nothing before the edit
    // knows that; the guard does.
    const result = await moveInstanceMethod.run(session, {
      symbol: 'priceCheck',
      to: 'invoice',
      apply: true,
    });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics.join('\n')).toContain('TS2341');
    expect(result.warnings.join('\n')).toContain('is private');
    expect(await readFile(src('order.ts'), 'utf8')).toContain('private priceCheck');
  });
});

describe('ts/refactors/move-instance-method apply mode', () => {
  it('writes the flip to disk, leaving the project compiling', { timeout: 60_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const file = (name: string) => path.join(root, 'src', name);
      const result = await moveInstanceMethod.run(copy, {
        symbol: 'bill',
        class: 'Order',
        to: 'invoice',
        apply: true,
      });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.applied).toBe(true);
      expect(await readFile(file('invoice.ts'), 'utf8')).toContain('bill(order: Order, note: string)');
      expect(await readFile(file('order.ts'), 'utf8')).not.toContain('bill(');
      expect(await readFile(file('checkout.ts'), 'utf8')).toContain(
        "invoice.bill(order, 'rush')",
      );

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

      // The session sees the project as it now is: the method is on
      // Invoice, so moving it back is a fresh, legal request.
      const back = await moveInstanceMethod.run(copy, {
        symbol: 'bill',
        class: 'Invoice',
        to: 'order',
      });
      expect(back.newDiagnostics).toEqual([]);
      expect(await preview(back.edit, file('order.ts'))).toContain(
        'bill(invoice: Invoice, note: string): number {',
      );
    });
  });

  it('writes a field-typed move to disk', { timeout: 60_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const file = (name: string) => path.join(root, 'src', name);
      const result = await moveInstanceMethod.run(copy, {
        symbol: 'render',
        class: 'Receipt',
        to: 'printer',
        apply: true,
      });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.applied).toBe(true);
      expect(await readFile(file('checkout.ts'), 'utf8')).toContain(
        'receipt.printer.render(receipt, 24)',
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
