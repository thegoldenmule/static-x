import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { applicableActions } from '../refactor-action.js';
import { preview, withProjectCopy } from '../testing.js';
import { memberForm } from './member-form.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/member-form-ts');
const METER_TS = path.join(FIXTURE, 'src/meter.ts');
const GAUGE_TS = path.join(FIXTURE, 'src/gauge.ts');
const REPORT_TS = path.join(FIXTURE, 'src/report.ts');
const CONSUMER_TS = path.join(FIXTURE, 'src/consumer.ts');
const EDGES_TS = path.join(FIXTURE, 'src/edges.ts');

function projectDiagnostics(session: TsProjectSession): string[] {
  return ts
    .getPreEmitDiagnostics(session.program())
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
}

const kinds = (result: { useSites: { file: string; kind: string }[] }) =>
  result.useSites.map((use) => `${path.basename(use.file)} ${use.kind}`);

describe('ts/refactors/member-form to: accessor', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('turns a zero-argument method into a getter and every call into a read', async () => {
    const result = await memberForm.run(session, { symbol: 'getTitle', to: 'accessor' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, REPORT_TS)).toContain(
      '  /** Human-readable heading. */\n  get title(): string {\n',
    );
    // The half no single-file edit can make: a call in another file.
    expect(await preview(result.edit, CONSUMER_TS)).toContain('`${report.title} ');
    expect(await preview(result.edit, REPORT_TS)).toContain('return [this.title].slice(0, limit);');
    expect(kinds(result)).toEqual([
      'consumer.ts direct-call',
      'report.ts direct-call',
      'report.ts direct-call',
    ]);
  });

  it('takes the property name from getName when one is given', async () => {
    const result = await memberForm.run(session, {
      symbol: 'getTitle',
      to: 'accessor',
      getName: 'heading',
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, REPORT_TS)).toContain('get heading(): string {');
    expect(await preview(result.edit, CONSUMER_TS)).toContain('`${report.heading} ');
  });

  it(
    "delegates the field case to TypeScript's generator, which a caret never reaches",
    async () => {
      // Measured, not assumed: getAccessorConvertiblePropertyAtPosition
      // requires the span to overlap the property name, so a scan that
      // probes carets finds this refactor at no position at all.
      const sourceFile = session.program().getSourceFile(GAUGE_TS)!;
      const name = (sourceFile.statements[0] as ts.ClassDeclaration).members[0]!.name!;
      const caret = applicableActions(session, GAUGE_TS, name.getStart(sourceFile));
      const range = applicableActions(session, GAUGE_TS, {
        pos: name.getStart(sourceFile),
        end: name.getEnd(),
      });
      const generate = (actions: { kind: string | undefined }[]) =>
        actions.some((action) => action.kind === 'refactor.rewrite.property.generateAccessors');
      expect(generate(caret)).toBe(false);
      expect(generate(range)).toBe(true);

      const result = await memberForm.run(session, { symbol: 'reading', to: 'accessor' });
      expect(result.newDiagnostics).toEqual([]);
      const gauge = await preview(result.edit, GAUGE_TS);
      // get before set: applyTextEdits works backwards, so two
      // insertions at one offset come out reversed unless re-ordered.
      expect(gauge).toContain(
        '  private _reading = 0;\n' +
          '  public get reading() {\n' +
          '    return this._reading;\n' +
          '  }\n' +
          '  public set reading(value) {\n' +
          '    this._reading = value;\n' +
          '  }\n',
      );
      // No use site changes: the property keeps its name.
      expect(await preview(result.edit, CONSUMER_TS)).toContain('gauge.reading += 2;');
      expect(result.warnings.join('\n')).toContain('own property');
    },
  );

  it('says so when the generator renames the accessor out from under an underscore', async () => {
    const result = await memberForm.run(session, { symbol: '_serial', to: 'accessor' });

    expect(await preview(result.edit, GAUGE_TS)).toContain('public get serial() {');
    expect(result.warnings.join('\n')).toContain(
      'names the accessor "serial" — a rename this tool did not ask for',
    );
  });

  it('refuses every method a property read cannot stand in for', async () => {
    // A parameter, so the call carries information a read cannot.
    await expect(memberForm.run(session, { symbol: 'getRows', to: 'accessor' })).rejects.toThrow(
      /takes 1 parameter/,
    );
    // Detached as a value: `d.getStamp` has no property-read spelling.
    await expect(memberForm.run(session, { symbol: 'getStamp', to: 'accessor' })).rejects.toThrow(
      /detached as a value[\s\S]*read: d\.getStamp/,
    );
    // A string key is found only because it is a literal; the message
    // says so, because a computed one would have compiled.
    await expect(memberForm.run(session, { symbol: 'getSize', to: 'accessor' })).rejects.toThrow(
      /reached through a string key/,
    );
    // Shared with a subclass: re-spelling one leaves the other.
    await expect(
      memberForm.run(session, { symbol: 'getName', class: 'Base', to: 'accessor' }),
    ).rejects.toThrow(/also declared by Child/);
    // No get/is/has prefix to strip, and no getName given.
    await expect(
      memberForm.run(session, { symbol: 'describe', class: 'Meter', to: 'accessor' }),
    ).rejects.toThrow(/not named get\*\/is\*\/has\*/);
    await expect(
      memberForm.run(session, { symbol: 'level', class: 'Meter', to: 'accessor' }),
    ).rejects.toThrow(/already spelled as an accessor/);
  });

  it('lets the guard refuse a class that stops satisfying a structural interface', async () => {
    // `Named` is never named by a heritage clause, so memberHierarchy
    // cannot see it and does not pretend to. The typecheck can.
    const result = await memberForm.run(session, {
      symbol: 'getLabel',
      class: 'Widget',
      to: 'accessor',
      apply: true,
    });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics.join('\n')).toContain(
      "Property 'getLabel' is missing in type 'Widget' but required in type 'Named'",
    );
    expect(await readFile(EDGES_TS, 'utf8')).toContain('getLabel(): string {');
  });
});

describe('ts/refactors/member-form to: field', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('collapses a get/set pair onto its backing field', async () => {
    const result = await memberForm.run(session, { symbol: 'level', class: 'Meter', to: 'field' });

    expect(result.newDiagnostics).toEqual([]);
    const meter = await preview(result.edit, METER_TS);
    expect(meter).toContain(
      '  /** Current level, in whatever unit this meter reads. */\n  level: number = 0;\n',
    );
    expect(meter).not.toContain('_level');
    expect(meter).not.toContain('get level');
    // The backing field's remaining uses move with it.
    expect(meter).toContain('    this.level = 0;');
    expect(meter).toContain('return `${this.#unit}:${this.level}`;');
    // Nothing outside the class changes: the public name is the same.
    expect(await preview(result.edit, CONSUMER_TS)).toContain('meter.level = meter.level + 1;');
    expect(kinds(result)).toEqual([
      'consumer.ts write',
      'consumer.ts read',
      'consumer.ts read',
      'meter.ts write',
      'meter.ts read',
    ]);
  });

  it('makes a getter with no setter readonly, keeping the constructor write', async () => {
    const result = await memberForm.run(session, { symbol: 'unit', class: 'Meter', to: 'field' });

    expect(result.newDiagnostics).toEqual([]);
    const meter = await preview(result.edit, METER_TS);
    expect(meter).toContain('  readonly unit: string;\n');
    // readonly permits exactly this write, which is why the collapse
    // does not have to keep the backing field for it.
    expect(meter).toContain('    this.unit = unit;');
    expect(meter).not.toContain('#unit');
    expect(result.warnings.join('\n')).toContain('the field is readonly');
  });

  it('refuses a pair whose bodies do more than move one field', async () => {
    await expect(
      memberForm.run(session, { symbol: 'v', class: 'Clamped', to: 'field' }),
    ).rejects.toThrow(/setter does more than assign its parameter to one field/);
    // `return this.peer._v` names a field this class does declare, so a
    // check on the name alone would collapse the getter onto the wrong
    // object's state and still compile. The receiver decides, not the name.
    await expect(
      memberForm.run(session, { symbol: 'mirrored', class: 'Mirror', to: 'field' }),
    ).rejects.toThrow(/getter does more than return one field/);
    await expect(
      memberForm.run(session, { symbol: 'getTitle', to: 'field' }),
    ).rejects.toThrow(/is a method[\s\S]*use to: "accessor" instead/);
    await expect(
      memberForm.run(session, { symbol: 'reading', to: 'field' }),
    ).rejects.toThrow(/already spelled as a field/);
  });
});

describe('ts/refactors/member-form to: method', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('rewrites reads, writes and compound writes across files', async () => {
    const result = await memberForm.run(session, { symbol: 'reading', to: 'method' });

    expect(result.newDiagnostics).toEqual([]);
    const gauge = await preview(result.edit, GAUGE_TS);
    expect(gauge).toContain(
      '  private _reading: number = 0;\n' +
        '\n' +
        '  getReading(): number {\n' +
        '    return this._reading;\n' +
        '  }\n' +
        '\n' +
        '  setReading(value: number) {\n' +
        '    this._reading = value;\n' +
        '  }\n' +
        '\n' +
        "  private _serial = 'g-0';\n",
    );
    // A write whose right-hand side reads the same member: three
    // adjacent edits, so the inner read gets its own rewrite.
    expect(gauge).toContain('    this.setReading(this.getReading() * 2);');
    expect(await preview(result.edit, CONSUMER_TS)).toContain(
      '  gauge.setReading(gauge.getReading() + 2);',
    );
    expect(kinds(result)).toEqual([
      'consumer.ts compound-write',
      'consumer.ts read',
      'gauge.ts write',
      'gauge.ts read',
      'gauge.ts read',
    ]);
  });

  it('asks the compiler where the parentheses go', async () => {
    const result = await memberForm.run(session, { symbol: 'level', class: 'Volume', to: 'method' });

    expect(result.newDiagnostics).toEqual([]);
    const edges = await preview(result.edit, EDGES_TS);
    // `v.level *= a + b` is the case a precedence-rank rule gets wrong:
    // v.setLevel(v.getLevel() * a + b) compiles and is a different sum.
    expect(edges).toContain('  v.setLevel(v.getLevel() * (a + b));');
    expect(edges).toContain('  v.setLevel(v.getLevel() + 1);');
  });

  it('keeps a readonly field writable only from its constructor', async () => {
    const result = await memberForm.run(session, { symbol: 'code', class: 'Sealed', to: 'method' });

    expect(result.newDiagnostics).toEqual([]);
    const edges = await preview(result.edit, EDGES_TS);
    expect(edges).toContain('  private readonly _code: string;');
    expect(edges).toContain('  getCode(): string {');
    expect(edges).not.toContain('setCode');
    // No setter to route through, so the constructor writes the field.
    expect(edges).toContain('    this._code = code;');
    expect(edges).toContain('    return this.getCode();');
    await expect(
      memberForm.run(session, { symbol: 'code', class: 'Sealed', to: 'method', setName: 'putCode' }),
    ).rejects.toThrow(/no set method for setName to name/);
  });

  it('names the class in a static member’s generated bodies', async () => {
    const result = await memberForm.run(session, {
      symbol: 'count',
      class: 'Registry',
      to: 'method',
    });

    expect(result.newDiagnostics).toEqual([]);
    const edges = await preview(result.edit, EDGES_TS);
    expect(edges).toContain('  private static _count: number = 0;');
    expect(edges).toContain('  static getCount(): number {\n    return Registry._count;\n  }');
    expect(edges).toContain('  static setCount(value: number) {\n    Registry._count = value;\n  }');
    expect(edges).toContain('  Registry.setCount(Registry.getCount() + 1);');
  });

  it('re-spells an accessor pair without touching either body', async () => {
    const result = await memberForm.run(session, { symbol: 'v', class: 'Clamped', to: 'method' });

    expect(result.newDiagnostics).toEqual([]);
    const edges = await preview(result.edit, EDGES_TS);
    // The clamp survives, which is the difference from to: "field" —
    // that conversion drops the body and so refuses this same pair.
    expect(edges).toContain('  getV(): number {\n    return this._v;\n  }');
    expect(edges).toContain('  setV(next: number) {\n    this._v = Math.max(0, next);\n  }');
  });

  it('refuses every use a get/set pair cannot stand in for', async () => {
    // Evaluating the receiver twice is the compound write's whole
    // hazard, and nothing in a typecheck reports it.
    await expect(
      memberForm.run(session, { symbol: 'count', class: 'Tally', to: 'method' }),
    ).rejects.toThrow(/receiver that does work \(`makeTally\(\)`\)/);
    // ||= assigns only when the current value is falsy; the expansion
    // assigns always.
    await expect(
      memberForm.run(session, { symbol: 'on', class: 'Toggle', to: 'method' }),
    ).rejects.toThrow(/assigned with \|\|=[\s\S]*assigns always/);
    // setX(...) returns void, so an assignment whose value is read
    // cannot be expanded at all.
    await expect(
      memberForm.run(session, { symbol: 'value', class: 'Slot', to: 'method' }),
    ).rejects.toThrow(/position whose value is used/);
    // `a.total += b.total` replaces the whole expression, which would
    // swallow the inner read.
    await expect(
      memberForm.run(session, { symbol: 'total', class: 'Sum', to: 'method' }),
    ).rejects.toThrow(/appears on both sides of the compound assignment/);
    await expect(
      memberForm.run(session, { symbol: 'left', class: 'Pair', to: 'method' }),
    ).rejects.toThrow(/destructured[\s\S]*destructure-read/);
    await expect(
      memberForm.run(session, { symbol: 'reading', to: 'method', getName: 'not an id' }),
    ).rejects.toThrow(/not a valid identifier/);
  });
});

describe('ts/refactors/member-form targeting', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('refuses an ambiguous name, and accepts class or position instead', async () => {
    await expect(memberForm.run(session, { symbol: 'level', to: 'field' })).rejects.toThrow(
      /names a member on several classes[\s\S]*Meter[\s\S]*Volume/,
    );
    const byPosition = await memberForm.run(session, {
      file: METER_TS,
      line: 10,
      character: 6,
      to: 'field',
    });
    expect(await preview(byPosition.edit, METER_TS)).toContain('  level: number = 0;');
  });

  it('does not conflate #x with x, and refuses a #private member outright', async () => {
    // Meter declares both `#unit` and `get unit()`. Matching by the
    // unprefixed name alone reports one member declared twice.
    await expect(memberForm.run(session, { symbol: '#unit', to: 'method' })).rejects.toThrow(
      /#private member/,
    );
    const unit = await memberForm.run(session, { symbol: 'unit', class: 'Meter', to: 'field' });
    expect(unit.newDiagnostics).toEqual([]);
  });

  it('names a parameter property for what it is', async () => {
    await expect(memberForm.run(session, { symbol: 'id', to: 'method' })).rejects.toThrow(
      /constructor parameter property/,
    );
    await expect(memberForm.run(session, { symbol: 'nothingNamedThis', to: 'field' })).rejects.toThrow(
      /No class member named/,
    );
  });
});

describe('ts/refactors/member-form apply mode', () => {
  it('writes a method-to-accessor conversion across files', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await memberForm.run(copy, { symbol: 'getTitle', to: 'accessor', apply: true });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.applied).toBe(true);
      expect(result.filesChanged.map((file) => path.basename(file))).toEqual([
        'consumer.ts',
        'report.ts',
      ]);

      expect(await readFile(path.join(root, 'src/report.ts'), 'utf8')).toContain(
        '  get title(): string {',
      );
      expect(await readFile(path.join(root, 'src/consumer.ts'), 'utf8')).toContain(
        '`${report.title} ',
      );
      expect(projectDiagnostics(copy)).toEqual([]);

      await expect(memberForm.run(copy, { symbol: 'title', to: 'accessor' })).rejects.toThrow(
        /already spelled as an accessor/,
      );
    });
  });

  it('writes an accessor-pair collapse and removes the backing field', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await memberForm.run(copy, {
        symbol: 'level',
        class: 'Meter',
        to: 'field',
        apply: true,
      });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.applied).toBe(true);

      const meter = await readFile(path.join(root, 'src/meter.ts'), 'utf8');
      expect(meter).toContain('  level: number = 0;');
      expect(meter).not.toContain('_level');
      expect(meter).toContain('    this.level = 0;');
      expect(projectDiagnostics(copy)).toEqual([]);
    });
  });

  it('writes a field-to-methods conversion and its call sites', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await memberForm.run(copy, { symbol: 'reading', to: 'method', apply: true });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.applied).toBe(true);

      const gauge = await readFile(path.join(root, 'src/gauge.ts'), 'utf8');
      expect(gauge).toContain('  private _reading: number = 0;');
      expect(gauge).toContain('    this.setReading(this.getReading() * 2);');
      expect(await readFile(path.join(root, 'src/consumer.ts'), 'utf8')).toContain(
        '  gauge.setReading(gauge.getReading() + 2);',
      );
      expect(projectDiagnostics(copy)).toEqual([]);
    });
  });
});
