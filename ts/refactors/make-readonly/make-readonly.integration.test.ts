import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkspaceEdit } from '../../../core/tool/index.js';
import { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { positionOf, preview, withProjectCopy } from '../testing.js';
import { makeReadonly } from './make-readonly.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/make-readonly-ts');
const COUNTER_TS = path.join(FIXTURE, 'src/counter.ts');
const BASKET_TS = path.join(FIXTURE, 'src/basket.ts');
const CONSUMER_TS = path.join(FIXTURE, 'src/consumer.ts');

const at = (place: { file: string; line: number; character: number }) =>
  `${path.basename(place.file)}:${place.line}:${place.character}`;

function projectDiagnostics(session: TsProjectSession): string[] {
  return ts
    .getPreEmitDiagnostics(session.program())
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
}

describe('ts/refactors/make-readonly', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it(
    'refuses a written property, at the positions the compiler flags',
    { timeout: 30_000 },
    async () => {
      const result = await makeReadonly.run(session, { symbol: 'total', apply: true });

      expect(result.applied).toBe(false);
      // One write in a method of the declaring class, one in another file.
      expect(result.writes.map((w) => `${at(w)} ${w.kind}`)).toEqual([
        `consumer.ts:${(await positionOf(CONSUMER_TS, 'counter.total = 0')).line}:10 write`,
        `counter.ts:${(await positionOf(COUNTER_TS, 'this.total += amount')).line}:9 compound-write`,
      ]);

      // The oracle, run independently on the edit the tool refused: the
      // compiler must find exactly the same writes, or the classifier
      // is wrong about what a write is.
      const oracle = (await diagnosticsIntroducedBy(session, result.edit)).filter(
        (d) => d.code === 2540,
      );
      expect(oracle).toHaveLength(2);
      expect(oracle.map((d) => at(d as Required<typeof d>)).sort()).toEqual(
        result.writes.map(at).sort(),
      );
      expect(result.newDiagnostics.join('\n')).toContain(
        "Cannot assign to 'total' because it is a read-only property",
      );
      expect(await readFile(COUNTER_TS, 'utf8')).toContain('total = 0;'); // refused: untouched
    },
  );

  it('writes the widened type when the property has no annotation', { timeout: 30_000 }, async () => {
    const result = await makeReadonly.run(session, { symbol: 'count' });

    expect(result.writes).toEqual([]);
    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, COUNTER_TS)).toContain('readonly count: number = 0;');

    // Why the annotation is not cosmetic: without it `readonly` narrows
    // the property to the literal type `0` and the constructor
    // assignment that compiles today stops compiling.
    const naive: WorkspaceEdit = {
      changes: {
        [COUNTER_TS]: result.edit.changes[COUNTER_TS]!.filter((e) => e.newText === 'readonly '),
      },
    };
    const narrowed = await diagnosticsIntroducedBy(session, naive);
    expect(narrowed.map((d) => d.code)).toEqual([2322]);
    expect(narrowed[0]!.message).toContain("Type 'number' is not assignable to type '0'");
  });

  it('adds the modifier to a parameter property after its accessibility modifier', async () => {
    const result = await makeReadonly.run(session, { symbol: 'owner' });

    expect(result.writes).toEqual([]);
    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, BASKET_TS)).toContain(
      'constructor(private readonly owner: string) {}',
    );
  });

  it('targets a #private field by name', { timeout: 30_000 }, async () => {
    const result = await makeReadonly.run(session, { symbol: '#tag' });

    expect(result.writes).toEqual([]); // the constructor write is permitted
    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, COUNTER_TS)).toContain('readonly #tag: string;');
  });

  it('refuses ambiguous and non-property targets', { timeout: 30_000 }, async () => {
    await expect(makeReadonly.run(session, { symbol: 'items' })).rejects.toThrow(
      /names a property on several classes[\s\S]*Basket[\s\S]*Crate/,
    );
    // Same name, disambiguated by declaring class.
    const crate = await makeReadonly.run(session, { symbol: 'items', class: 'Crate' });
    expect(Object.keys(crate.edit.changes)).toEqual([BASKET_TS]);
    expect(await preview(crate.edit, BASKET_TS)).toContain(
      'export class Crate {\n  readonly items: string[] = [];',
    );

    const summarize = await positionOf(CONSUMER_TS, 'summarize');
    await expect(makeReadonly.run(session, { file: CONSUMER_TS, ...summarize })).rejects.toThrow(
      /readonly applies to class properties/,
    );
    await expect(makeReadonly.run(session, { symbol: 'nothingNamedThis' })).rejects.toThrow(
      /No class property named/,
    );
  });
});

describe('ts/refactors/make-readonly apply mode', () => {
  it(
    'applies to a property another file reads by destructuring',
    { timeout: 30_000 },
    async () => {
      await withProjectCopy(FIXTURE, async (copy, root) => {
        // `const { label } = counter` is the reference ReferenceEntry
        // .isWriteAccess calls a write; classifying by parent node
        // calls it what it is, so this applies rather than refusing.
        const result = await makeReadonly.run(copy, { symbol: 'label', apply: true });

        expect(result.writes).toEqual([]);
        expect(result.newDiagnostics).toEqual([]);
        expect(result.applied).toBe(true);

        const counter = await readFile(path.join(root, 'src/counter.ts'), 'utf8');
        expect(counter).toContain('readonly label: string;');
        expect(counter).toContain('this.label = `counter(${limit})`;'); // constructor write kept
        expect(await readFile(path.join(root, 'src/consumer.ts'), 'utf8')).toContain(
          'const { label } = counter;',
        );
        expect(projectDiagnostics(copy)).toEqual([]);

        await expect(makeReadonly.run(copy, { symbol: 'label' })).rejects.toThrow(
          /already readonly/,
        );
      });
    },
  );

  it(
    'applies to an array property, warning that readonly does not freeze it',
    { timeout: 30_000 },
    async () => {
      await withProjectCopy(FIXTURE, async (copy, root) => {
        const result = await makeReadonly.run(copy, {
          symbol: 'items',
          class: 'Basket',
          apply: true,
        });

        expect(result.applied).toBe(true);
        expect(result.newDiagnostics).toEqual([]);

        const basket = await readFile(path.join(root, 'src/basket.ts'), 'utf8');
        expect(basket).toContain('readonly items: string[] = [];');
        // The mutation the modifier does not stop, still compiling.
        expect(basket).toContain('this.items.push(item);');
        expect(projectDiagnostics(copy)).toEqual([]);

        const warnings = result.warnings.join('\n');
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(warnings).toContain('readonly is shallow');
        expect(warnings).toContain('does not freeze');
        expect(warnings).toContain('push() at src/basket.ts:8:10');
        expect(warnings).toContain('erased at compile time');
        expect(warnings).toContain('Assignability ignores readonly');
      });
    },
  );
});
