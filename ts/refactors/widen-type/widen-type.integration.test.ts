import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { positionOf, preview, withProjectCopy } from '../testing.js';
import { widenType } from './widen-type.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/widen-type-ts');
const KENNEL_TS = path.join(FIXTURE, 'src/kennel.ts');
const SHELTER_TS = path.join(FIXTURE, 'src/shelter.ts');
const REGISTRY_TS = path.join(FIXTURE, 'src/registry.ts');

function projectDiagnostics(session: TsProjectSession): string[] {
  return ts
    .getPreEmitDiagnostics(session.program())
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
}

describe('ts/refactors/widen-type', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it(
    'takes the widest interface that survives the typecheck, and imports it',
    { timeout: 60_000 },
    async () => {
      const result = await widenType.run(session, { symbol: 'pet' });

      expect(result.from).toBe('Dog');
      expect(result.to).toBe('Named');
      // Widest first: Named is above Animal, so Animal is never tried.
      expect(result.candidates).toEqual(['Named', 'Animal']);
      expect(result.rejected).toEqual([]);
      expect(result.newDiagnostics).toEqual([]);

      const text = await preview(result.edit, KENNEL_TS);
      expect(text).toContain('export function label(pet: Named): string {');
      // Named was not imported; the import fix put it beside Dog, which
      // the file's other functions still use.
      expect(text).toContain("import { Dog, Named } from './shapes.js';");
      expect(text).toContain('export function announce(speaker: Dog): string {');
    },
  );

  it(
    'falls back to the class when no single interface carries every member used',
    { timeout: 60_000 },
    async () => {
      const result = await widenType.run(session, { symbol: 'speaker' });

      // `.name` and `speak()` together rule out Named and Speaker
      // before any typecheck runs, so Animal is the only candidate.
      expect(result.candidates).toEqual(['Animal']);
      expect(result.to).toBe('Animal');
      const text = await preview(result.edit, KENNEL_TS);
      expect(text).toContain('export function announce(speaker: Animal): string {');
      expect(text).toContain("import { Animal, Dog } from './shapes.js';");
    },
  );

  it('names a type alias by its alias, not by its type', { timeout: 60_000 }, async () => {
    // `type Vitals = { … }` has a type whose own symbol is the type
    // literal, named `__type`. Reading the name off the type instead of
    // off the alias would propose `__type` as an annotation.
    const result = await widenType.run(session, { symbol: 'entrant' });

    expect(result.candidates).toEqual(['Vitals']);
    expect(result.to).toBe('Vitals');
    const text = await preview(result.edit, KENNEL_TS);
    expect(text).toContain('export function papers(entrant: Vitals): string {');
    expect(text).toContain("import { Dog, Vitals } from './shapes.js';");
  });

  it('refuses an annotation nothing above it can replace', { timeout: 60_000 }, async () => {
    // `.breed` and `fetch()` together exist only on Dog.
    await expect(widenType.run(session, { symbol: 'champion' })).rejects.toThrow(
      /`Dog` is already the widest annotation available for "champion"[\s\S]*"breed", "fetch"/,
    );
  });

  it('refuses a declaration with no annotation', { timeout: 60_000 }, async () => {
    await expect(widenType.run(session, { symbol: 'inferred' })).rejects.toThrow(
      /has no type annotation[\s\S]*inference already/,
    );
  });

  it('refuses when nothing is wider than what is written', { timeout: 60_000 }, async () => {
    await expect(widenType.run(session, { symbol: 'value' })).rejects.toThrow(
      /annotated `unknown`, and nothing is wider/,
    );
  });

  it('refuses an ambiguous symbol rather than widening the first match', async () => {
    await expect(widenType.run(session, { symbol: 'subject' })).rejects.toThrow(
      /"subject" names 2 declarations; disambiguate with file\/line\/character/,
    );
  });

  it('refuses a non-annotatable target', { timeout: 60_000 }, async () => {
    const where = await positionOf(KENNEL_TS, 'export function label');
    await expect(
      widenType.run(session, {
        file: KENNEL_TS,
        line: where.line,
        character: where.character + 'export function '.length,
      }),
    ).rejects.toThrow(/A type annotation belongs to a parameter, variable, or property/);
  });

  it(
    'refuses a decorated declaration when emitDecoratorMetadata is on',
    { timeout: 60_000 },
    async () => {
      // Only `.name` is read off it, so `Named` would otherwise apply —
      // the refusal is about emit, which the guard cannot see.
      await expect(widenType.run(session, { symbol: 'headliner' })).rejects.toThrow(
        /decorated and this project sets emitDecoratorMetadata[\s\S]*a typecheck cannot see that/,
      );
      expect(await readFile(REGISTRY_TS, 'utf8')).toContain('headliner: Dog =');
    },
  );

  it(
    'synthesizes a type literal in structural mode when no named type fits',
    { timeout: 60_000 },
    async () => {
      const subject = await positionOf(KENNEL_TS, 'export function audit(subject: Dog)');
      const at = {
        file: KENNEL_TS,
        line: subject.line,
        character: subject.character + 'export function audit('.length,
      };

      // `.name` and `.age` is a pair no declared type carries.
      await expect(widenType.run(session, { ...at, mode: 'declared' })).rejects.toThrow(
        /already the widest annotation available for "subject"/,
      );

      const result = await widenType.run(session, { ...at, mode: 'structural' });
      expect(result.candidates).toEqual(['{ readonly age: number; readonly name: string; }']);
      expect(result.to).toBe('{ readonly age: number; readonly name: string; }');
      expect(await preview(result.edit, KENNEL_TS)).toContain(
        'export function audit(subject: { readonly age: number; readonly name: string; }): string {',
      );
    },
  );

  it('keeps a method a method when synthesizing', { timeout: 60_000 }, async () => {
    const result = await widenType.run(session, { symbol: 'speaker', mode: 'structural' });

    // `speak(): string`, not `speak: () => string`: the property
    // spelling is contravariant under strictFunctionTypes and can fail
    // where the method it came from passes.
    expect(result.candidates[0]).toBe('{ readonly name: string; speak(): string; }');
    expect(result.to).toBe('{ readonly name: string; speak(): string; }');
    expect(await preview(result.edit, KENNEL_TS)).toContain(
      'announce(speaker: { readonly name: string; speak(): string; }): string {',
    );
  });

  it(
    'searches past a candidate the compiler rejects, and says what it said',
    { timeout: 60_000 },
    async () => {
      // `guest` is read for `.name` — which both candidates carry, so
      // the member prefilter cannot separate them — and then handed to
      // a function wanting an Animal. Only the typecheck knows.
      const result = await widenType.run(session, { symbol: 'guest' });

      expect(result.candidates).toEqual(['Named', 'Animal']);
      expect(result.to).toBe('Animal');
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]!.type).toBe('Named');
      expect(result.rejected[0]!.reason).toContain('TS2345');
      expect(result.rejected[0]!.reason).toContain(
        "Argument of type 'Named' is not assignable to parameter of type 'Animal'",
      );
      expect(await preview(result.edit, KENNEL_TS)).toContain(
        'export function invoice(guest: Animal): string {',
      );
    },
  );

  it('reports nothing widened when every candidate fails', { timeout: 60_000 }, async () => {
    // The bound stops the search on the widest candidate, which is the
    // one the compiler rejects.
    const result = await widenType.run(session, { symbol: 'guest', maxCandidates: 1 });

    expect(result.to).toBeUndefined();
    expect(result.applied).toBe(false);
    expect(result.candidates).toEqual(['Named']);
    expect(result.rejected).toHaveLength(1);
    expect(result.edit.changes).toEqual({});
    expect(result.newDiagnostics).toEqual([]);
    expect(result.warnings.join('\n')).toContain('Raise maxCandidates');
  });

  it(
    'proposes unknown when no member is read, and lets the guard settle the rest',
    { timeout: 60_000 },
    async () => {
      const result = await widenType.run(session, { symbol: 'passenger', mode: 'structural' });

      // Nothing is read off `passenger`, so the member prefilter
      // eliminates nothing and the whole lattice is in play. The search
      // stops at Animal, so Vitals is listed but never typechecked.
      expect(result.candidates).toEqual([
        'unknown',
        'Aged',
        'Named',
        'Speaker',
        'Animal',
        'Vitals',
      ]);
      expect(result.to).toBe('Animal');
      expect(result.rejected.map((r) => r.type)).toEqual(['unknown', 'Aged', 'Named', 'Speaker']);
      expect(await preview(result.edit, KENNEL_TS)).toContain(
        'export function forward(passenger: Animal): string {',
      );
    },
  );

  it('warns that an exported annotation leaves this compilation', { timeout: 60_000 }, async () => {
    const result = await widenType.run(session, { symbol: 'featured' });
    expect(result.to).toBe('Named');
    expect(result.warnings.join('\n')).toContain("part of this module's public surface");
  });
});

describe('ts/refactors/widen-type apply mode', () => {
  it(
    'widens a property another file reads through, leaving the project clean',
    { timeout: 60_000 },
    async () => {
      await withProjectCopy(FIXTURE, async (copy, root) => {
        const result = await widenType.run(copy, { symbol: 'star', apply: true });

        expect(result.applied).toBe(true);
        expect(result.from).toBe('Dog');
        expect(result.to).toBe('Named');
        expect(result.newDiagnostics).toEqual([]);

        const shelter = await readFile(path.join(root, 'src/shelter.ts'), 'utf8');
        expect(shelter).toContain('readonly star: Named;');
        // The constructor still takes a Dog and still assigns it.
        expect(shelter).toContain('constructor(adopted: Dog) {');
        expect(shelter).toContain('this.star = adopted;');
        expect(shelter).toContain("import { Dog, Named } from './shapes.js';");

        // The oracle the whole tool is built on: reopen the written
        // project and ask the compiler directly.
        expect(projectDiagnostics(copy)).toEqual([]);

        // Nothing above Named is left, so a second run has nowhere to go.
        await expect(widenType.run(copy, { symbol: 'star' })).rejects.toThrow(
          /already the widest annotation available/,
        );
      });
    },
  );

  it('applies a synthesized structural type', { timeout: 60_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const kennel = path.join(root, 'src/kennel.ts');
      const subject = await positionOf(kennel, 'export function audit(subject: Dog)');
      const result = await widenType.run(copy, {
        file: kennel,
        line: subject.line,
        character: subject.character + 'export function audit('.length,
        mode: 'structural',
        apply: true,
      });

      expect(result.applied).toBe(true);
      expect(await readFile(kennel, 'utf8')).toContain(
        'audit(subject: { readonly age: number; readonly name: string; }): string {',
      );
      expect(projectDiagnostics(copy)).toEqual([]);
    });
  });
});

describe('ts/refactors/widen-type shelter fixture is stable', () => {
  it('leaves the fixture untouched after dry runs', async () => {
    expect(await readFile(SHELTER_TS, 'utf8')).toContain('readonly star: Dog;');
  });
});
