import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { staticForm } from './static-form.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/static-form-ts');
const src = (file: string) => path.join(FIXTURE, 'src', file);

describe('ts/refactors/static-form to static', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('adds static and re-points every call, including `this.m()`', { timeout: 30_000 }, async () => {
    const before = await readFile(src('formatter.ts'), 'utf8');
    const result = await staticForm.run(session, {
      symbol: 'pad',
      class: 'Formatter',
      to: 'static',
    });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics).toEqual([]);

    const formatter = await preview(result.edit, src('formatter.ts'));
    expect(formatter).toContain('  static pad(value: string, width: number): string {\n');
    // The receiver inside the class is `this`, and it is a receiver like
    // any other: the call has to stop naming one.
    expect(formatter).toContain('    return Formatter.pad(this.label, width);\n');

    expect(result.callSites.map((site) => `${path.basename(site.file)}:${site.line + 1}`)).toEqual([
      'board.ts:5',
      'desk.ts:6',
      'formatter.ts:15',
      'receipt.ts:5',
    ]);

    // Dry run: nothing on disk changed.
    expect(await readFile(src('formatter.ts'), 'utf8')).toBe(before);
  });

  it('reports a dropped receiver the effect check cannot certify', { timeout: 30_000 }, async () => {
    const result = await staticForm.run(session, {
      symbol: 'pad',
      class: 'Formatter',
      to: 'static',
    });

    // `desk.fmt` calls nothing, so it is not refused — but it is a
    // property read, and a property read runs a getter if one is
    // declared. That is the hole in every syntactic purity check, and
    // the typecheck says nothing about it either.
    expect(await preview(result.edit, src('desk.ts'))).toContain(
      "  return Formatter.pad('desk', width);\n",
    );
    expect(result.warnings.join('\n')).toContain('drops the receiver `desk.fmt`');
  });

  it('imports the class where a call site cannot name it', { timeout: 30_000 }, async () => {
    const result = await staticForm.run(session, {
      symbol: 'pad',
      class: 'Formatter',
      to: 'static',
    });

    // board.ts reached the method through a factory and never named the
    // class, so the rewrite has to introduce the name it now needs.
    expect(await preview(result.edit, src('board.ts'))).toBe(
      "import { makeFormatter } from './factory.js';\n" +
        "import { Formatter } from './formatter.js';\n" +
        '\n' +
        'export function board(width: number): string {\n' +
        '  const fmt = makeFormatter();\n' +
        "  return `${fmt.label} ${Formatter.pad('total', width)}`;\n" +
        '}\n',
    );
  });

  it('writes the name the call site already binds, alias and all', { timeout: 30_000 }, async () => {
    const result = await staticForm.run(session, {
      symbol: 'pad',
      class: 'Formatter',
      to: 'static',
    });

    // receipt.ts imports the class as Fmt. A second binding for one
    // class would compile and read as two.
    expect(await preview(result.edit, src('receipt.ts'))).toBe(
      "import { Formatter as Fmt } from './formatter.js';\n" +
        '\n' +
        'export function receipt(width: number): string {\n' +
        "  const fmt = new Fmt('receipt');\n" +
        "  return Fmt.pad('due', width);\n" +
        '}\n',
    );
  });

  it('makes a property static and re-points its reads, with the slot warning', { timeout: 30_000 }, async () => {
    const result = await staticForm.run(session, { symbol: 'limit', to: 'static' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('counter.ts'))).toContain(
      '  static readonly limit = 100;\n',
    );
    expect(await preview(result.edit, src('counter.ts'))).toContain(
      '    return Counter.limit - this.seen;\n',
    );
    expect(await preview(result.edit, src('limits.ts'))).toContain(
      '  return Counter.limit - counter.room();\n',
    );
    // Nothing writes it, so the two programs agree today — which is
    // exactly the thing a future write would break, and a typecheck
    // would not mention.
    expect(result.warnings.join('\n')).toContain('one slot shared by every instance');
  });
});

describe('ts/refactors/static-form to instance', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('promotes a parameter to the receiver at every call site', { timeout: 30_000 }, async () => {
    const result = await staticForm.run(session, {
      symbol: 'scale',
      class: 'Money',
      to: 'instance',
      receiver: 'amount',
    });

    expect(result.newDiagnostics).toEqual([]);
    const money = await preview(result.edit, src('money.ts'));
    expect(money).toContain('  scale(factor: number): Money {\n');
    expect(money).toContain('    return new Money(Math.round(this.cents * factor));\n');
    // A call from another static of the same class is a call site too.
    expect(money).toContain('    return amount.scale(0.5);\n');

    expect(await preview(result.edit, src('invoice.ts'))).toBe(
      "import { Money } from './money.js';\n" +
        '\n' +
        'export function withTax(net: Money): Money {\n' +
        '  return net.scale(1.2);\n' +
        '}\n' +
        '\n' +
        'export function doubled(net: Money): Money {\n' +
        '  return net.scale(2);\n' +
        '}\n',
    );
    expect(result.callSites.map((site) => path.basename(site.file))).toEqual([
      'cartlines.ts',
      'invoice.ts',
      'invoice.ts',
      'money.ts',
    ]);
  });

  it('finds the argument through the resolved signature, not the declaration', { timeout: 30_000 }, async () => {
    // `seal(this: void, vault: Vault, note: string)` declares the
    // receiver at parameter 1 and passes it as argument 0, because a
    // `this` parameter occupies no slot in the argument list. Counting
    // declaration positions would delete the note and leave the vault.
    const result = await staticForm.run(session, {
      symbol: 'seal',
      to: 'instance',
      receiver: 'vault',
    });

    expect(result.newDiagnostics).toEqual([]);
    const vault = await preview(result.edit, src('vault.ts'));
    expect(vault).toContain('  seal(note: string): string {\n');
    expect(vault).toContain('    return `${this.id}:${note}`;\n');
    expect(vault).not.toContain('this: void');
    expect(await preview(result.edit, src('depot.ts'))).toContain(
      '  return vault.seal(note);\n',
    );
  });

  it('drops the class import the rewrite leaves unused', { timeout: 30_000 }, async () => {
    const result = await staticForm.run(session, {
      symbol: 'scale',
      class: 'Money',
      to: 'instance',
      receiver: 'amount',
    });

    // cartlines.ts named Money only to reach the static. depot.ts and
    // invoice.ts still name it in annotations, so their imports stay.
    expect(await preview(result.edit, src('cartlines.ts'))).toBe(
      "import type { Line } from './types.js';\n" +
        '\n' +
        'export function scaled(line: Line, factor: number) {\n' +
        '  return line.amount.scale(factor);\n' +
        '}\n',
    );
  });
});

describe('ts/refactors/static-form refusals', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('refuses a body that reads `this`', { timeout: 30_000 }, async () => {
    await expect(
      staticForm.run(session, { symbol: 'describe', class: 'Formatter', to: 'static' }),
    ).rejects.toThrow(/reads `this`/);
    // The same check runs the other way: in a static `this` is the
    // constructor, and it would become the instance.
    await expect(
      staticForm.run(session, { symbol: 'origin', to: 'instance', receiver: 'amount' }),
    ).rejects.toThrow(/reads `this`.*would become the instance/s);
  });

  it('refuses a body that reads `super`', { timeout: 30_000 }, async () => {
    await expect(staticForm.run(session, { symbol: 'shout', to: 'static' })).rejects.toThrow(
      /reads `super`/,
    );
  });

  it('refuses a member handed out as a value', { timeout: 30_000 }, async () => {
    await expect(staticForm.run(session, { symbol: 'measure', to: 'static' })).rejects.toThrow(
      /is not only called/,
    );
    await expect(
      staticForm.run(session, { symbol: 'bump', class: 'Money', to: 'instance', receiver: 'amount' }),
    ).rejects.toThrow(/is not only called/);
  });

  it('refuses a call site whose receiver does something', { timeout: 30_000 }, async () => {
    // `makeFormatter().trim(x)` would become `Formatter.trim(x)`, which
    // compiles and no longer builds a formatter.
    await expect(staticForm.run(session, { symbol: 'trim', to: 'static' })).rejects.toThrow(
      /receiver that does something[\s\S]*makeFormatter\(\)/,
    );
  });

  it('refuses references the rewrite cannot describe', { timeout: 30_000 }, async () => {
    // A string key and an optional chain: the first is invisible to the
    // rewrite, the second carries a nullish guard that would vanish.
    await expect(staticForm.run(session, { symbol: 'quote', to: 'static' })).rejects.toThrow(
      /fmt\['quote'\][\s\S]*optional chaining/,
    );
  });

  it('refuses a member the hierarchy shares', { timeout: 30_000 }, async () => {
    await expect(
      staticForm.run(session, { symbol: 'title', class: 'Report', to: 'static' }),
    ).rejects.toThrow(/also declared by MonthlyReport/);
  });

  it('refuses an accessor', { timeout: 30_000 }, async () => {
    await expect(staticForm.run(session, { symbol: 'currency', to: 'static' })).rejects.toThrow(
      /is an accessor/,
    );
  });

  it('refuses a property anything writes, or whose initializer does anything', { timeout: 30_000 }, async () => {
    await expect(staticForm.run(session, { symbol: 'seen', to: 'static' })).rejects.toThrow(
      /one slot shared by every instance/,
    );
    await expect(staticForm.run(session, { symbol: 'startedAt', to: 'static' })).rejects.toThrow(
      /evaluated once per instance today/,
    );
  });

  it('refuses a member already in the requested form', { timeout: 30_000 }, async () => {
    await expect(
      staticForm.run(session, { symbol: 'scale', class: 'Money', to: 'static' }),
    ).rejects.toThrow(/already static/);
    await expect(
      staticForm.run(session, { symbol: 'pad', class: 'Formatter', to: 'instance' }),
    ).rejects.toThrow(/already an instance member/);
  });

  it('refuses to: instance without a usable receiver', { timeout: 30_000 }, async () => {
    await expect(
      staticForm.run(session, { symbol: 'scale', class: 'Money', to: 'instance' }),
    ).rejects.toThrow(/needs `receiver`/);
    await expect(
      staticForm.run(session, { symbol: 'scale', class: 'Money', to: 'instance', receiver: 'nope' }),
    ).rejects.toThrow(/has no parameter named "nope"/);
  });

  it('refuses a receiver parameter that is not the declaring class', { timeout: 30_000 }, async () => {
    await expect(
      staticForm.run(session, { symbol: 'stamp', to: 'instance', receiver: 'box' }),
    ).rejects.toThrow(/typed `Box`, not `Crate`[\s\S]*move-instance-method/);
  });

  it('refuses a call site that omits the receiver', { timeout: 30_000 }, async () => {
    await expect(
      staticForm.run(session, { symbol: 'render', to: 'instance', receiver: 'label' }),
    ).rejects.toThrow(/omits "label"/);
  });

  it('refuses a receiver the body reassigns or reads under another `this`', { timeout: 30_000 }, async () => {
    await expect(
      staticForm.run(session, { symbol: 'clamp', to: 'instance', receiver: 'amount' }),
    ).rejects.toThrow(/`this` cannot be reassigned/);
    await expect(
      staticForm.run(session, { symbol: 'repeat', to: 'instance', receiver: 'amount' }),
    ).rejects.toThrow(/binds its own `this`/);
  });

  it('refuses a property for to: instance, and a module-level declaration for either', { timeout: 30_000 }, async () => {
    await expect(
      staticForm.run(session, { symbol: 'ceiling', to: 'instance', receiver: 'x' }),
    ).rejects.toThrow(/property has no parameter to promote/);
    await expect(staticForm.run(session, { symbol: 'board', to: 'static' })).rejects.toThrow(
      /not a class member/,
    );
  });

  it('refuses an ambiguous target, and takes `class` to settle it', { timeout: 30_000 }, async () => {
    await expect(staticForm.run(session, { symbol: 'bump', to: 'static' })).rejects.toThrow(
      /declared in multiple files/,
    );
    await expect(
      staticForm.run(session, { symbol: 'pad', class: 'Nowhere', to: 'static' }),
    ).rejects.toThrow(/No member named "pad" is declared on class "Nowhere"/);
  });
});

describe('ts/refactors/static-form apply mode', () => {
  it('writes the static form to disk, leaving the project compiling', { timeout: 60_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const file = (name: string) => path.join(root, 'src', name);
      const result = await staticForm.run(copy, {
        symbol: 'pad',
        class: 'Formatter',
        to: 'static',
        apply: true,
      });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.applied).toBe(true);
      expect(await readFile(file('formatter.ts'), 'utf8')).toContain('static pad(');
      expect(await readFile(file('board.ts'), 'utf8')).toContain(
        "import { Formatter } from './formatter.js';",
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

      // The session must see the project as it now is.
      await expect(
        staticForm.run(copy, { symbol: 'pad', class: 'Formatter', to: 'static' }),
      ).rejects.toThrow(/already static/);
    });
  });

  it('writes the instance form to disk, leaving the project compiling', { timeout: 60_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const file = (name: string) => path.join(root, 'src', name);
      const result = await staticForm.run(copy, {
        symbol: 'scale',
        class: 'Money',
        to: 'instance',
        receiver: 'amount',
        apply: true,
      });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.applied).toBe(true);
      expect(await readFile(file('money.ts'), 'utf8')).toContain('  scale(factor: number): Money {');
      expect(await readFile(file('invoice.ts'), 'utf8')).toContain('return net.scale(1.2);');
      expect(await readFile(file('cartlines.ts'), 'utf8')).not.toContain('money.js');

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

      await expect(
        staticForm.run(copy, {
          symbol: 'scale',
          class: 'Money',
          to: 'instance',
          receiver: 'amount',
        }),
      ).rejects.toThrow(/already an instance member/);
    });
  });
});
