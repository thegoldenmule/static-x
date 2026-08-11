import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { extractInterface } from './extract-interface.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/extract-interface-ts');
const KENNEL_TS = path.join(FIXTURE, 'src/kennel.ts');
const CONSUMER_TS = path.join(FIXTURE, 'src/consumer.ts');
const REPORT_TS = path.join(FIXTURE, 'src/report.ts');
const AUDIT_TS = path.join(FIXTURE, 'src/audit.ts');
const ANNEX_TS = path.join(FIXTURE, 'src/annex.ts');
const CRATE_TS = path.join(FIXTURE, 'src/crate.ts');
const POUND_TS = path.join(FIXTURE, 'src/pound.ts');

const KENNEL_INTERFACE = `export interface Boarding {
  readonly name: string;
  /** Dogs currently boarding. */
  occupancy: number;
  rating: number;
  get vacancies(): number;
  /** Books a dog in, returning the run it was given. */
  book(dog: string, nights?: number): number;
  tag(): Tag;
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

describe('ts/refactors/extract-interface', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it(
    'carries the public instance members and asserts them with implements',
    { timeout: 60_000 },
    async () => {
      const result = await extractInterface.run(session, { symbol: 'Kennel', name: 'Boarding' });

      // Static, #-named, protected, private and the constructor are all out.
      expect(result.members).toEqual([
        'name',
        'occupancy',
        'rating',
        'vacancies',
        'book',
        'tag',
      ]);
      expect(result.newDiagnostics).toEqual([]);

      const text = await preview(result.edit, KENNEL_TS);
      expect(text).toContain(KENNEL_INTERFACE);
      expect(text).toContain('export class Kennel implements Boarding {');
      // Signatures come from the declarations: `nights = 1` has no
      // annotation and no writable default, so it becomes optional, and
      // `occupancy = 0` gets the type the checker reports for it.
      expect(text).toContain('book(dog: string, nights?: number): number;');
      expect(text).toContain('  occupancy: number;');
      // A getter stays a getter rather than flattening to `readonly`.
      expect(text).toContain('  get vacancies(): number;');
      // The class body is untouched apart from the heritage clause.
      expect(text).toContain('  book(dog: string, nights = 1): number {');
      expect(text).toContain('  private seal(): void {');
    },
  );

  it('rewrites use-site annotations and repairs the imports', { timeout: 60_000 }, async () => {
    const result = await extractInterface.run(session, { symbol: 'Kennel', name: 'Boarding' });

    expect(
      result.useSites.map((site) => `${path.relative(FIXTURE, site.file)}:${site.line + 1}`),
    ).toEqual([
      'src/audit.ts:8',
      'src/consumer.ts:3',
      'src/consumer.ts:7',
      'src/consumer.ts:14',
      'src/kennel.ts:40',
      'src/report.ts:3',
    ]);

    // consumer.ts still constructs the class, so its value import stays
    // and the interface joins it as an inline type import.
    const consumer = await preview(result.edit, CONSUMER_TS);
    expect(consumer).toContain("import { Kennel, type Boarding } from './kennel.js';");
    expect(consumer).toContain('export function summarize(kennel: Boarding): string {');
    expect(consumer).toContain("export const flagship: Boarding = new Kennel('flagship');");

    // report.ts named the class only in the annotation that just moved,
    // so the import of the class goes with it.
    const report = await preview(result.edit, REPORT_TS);
    expect(report).toContain("import type { Boarding } from './kennel.js';");
    expect(report).not.toContain('Kennel');

    // A nested annotation is rewritten too — the tool's own analysis
    // does not look inside one, but the text edit does.
    expect(await preview(result.edit, AUDIT_TS)).toContain(
      'export function ratings(kennels: readonly Boarding[]): number[] {',
    );
  });

  it('says what the interface cannot decouple', { timeout: 60_000 }, async () => {
    const result = await extractInterface.run(session, { symbol: 'Kennel', name: 'Boarding' });
    expect(result.warnings.join('\n')).toContain(
      'src/consumer.ts, src/kennel.ts still construct Kennel directly',
    );
    expect(result.warnings.join('\n')).toContain('`new` needs the class');
  });

  it(
    'puts the interface in another module with the imports its signatures need',
    { timeout: 60_000 },
    async () => {
      const result = await extractInterface.run(session, {
        symbol: 'Kennel',
        name: 'Boarding',
        targetFile: 'src/boarding.ts',
      });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.edit.fileOps).toEqual([
        { kind: 'create', file: path.join(FIXTURE, 'src/boarding.ts') },
      ]);

      // `tag(): Tag` names a type the class file imported; the new file
      // needs the same binding, re-based to its own directory.
      const boarding = await preview(result.edit, path.join(FIXTURE, 'src/boarding.ts'));
      expect(boarding).toBe(`import type { Tag } from './shapes.js';\n\n${KENNEL_INTERFACE}\n`);

      const kennel = await preview(result.edit, KENNEL_TS);
      expect(kennel).toContain("import type { Boarding } from './boarding.js';");
      expect(kennel).toContain('export class Kennel implements Boarding {');
      expect(kennel).not.toContain('export interface Boarding');

      expect(await preview(result.edit, REPORT_TS)).toContain(
        "import type { Boarding } from './boarding.js';",
      );
    },
  );

  it('appends to an existing destination module', { timeout: 60_000 }, async () => {
    const result = await extractInterface.run(session, {
      symbol: 'Kennel',
      name: 'Boarding',
      targetFile: 'src/shapes.ts',
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.edit.fileOps).toBeUndefined();
    // `Tag` is declared in the destination, so nothing is imported for it.
    const shapes = await preview(result.edit, path.join(FIXTURE, 'src/shapes.ts'));
    expect(shapes).toBe(
      `export interface Tag {\n  readonly label: string;\n}\n\n${KENNEL_INTERFACE}\n`,
    );
    // The class file already imported from there, so the name joins that
    // clause rather than opening a second import of the same module.
    expect(await preview(result.edit, KENNEL_TS)).toContain(
      "import type { Tag, Boarding } from './shapes.js';",
    );
  });

  it('imports the class itself when a signature names it', { timeout: 60_000 }, async () => {
    const result = await extractInterface.run(session, {
      symbol: 'Pound',
      name: 'PoundLike',
      targetFile: 'src/pound-like.ts',
      updateUseSites: false,
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, path.join(FIXTURE, 'src/pound-like.ts'))).toBe(
      `import type { Pound } from './pound.js';\n\n` +
        `export interface PoundLike {\n` +
        `  readonly town: string;\n` +
        `  /** True when both pounds answer to the same registry key. */\n` +
        `  matches(other: Pound): boolean;\n` +
        `}\n`,
    );
    expect(await preview(result.edit, POUND_TS)).toContain(
      "import type { PoundLike } from './pound-like.js';",
    );
  });

  it(
    'refuses a destination that cannot name what the signatures name',
    { timeout: 60_000 },
    async () => {
      // `shift(): Shift` names a type warden.ts declares but does not
      // export, so no other module can write the signature at all.
      await expect(
        extractInterface.run(session, {
          symbol: 'Warden',
          name: 'WardenLike',
          targetFile: 'src/warden-like.ts',
        }),
      ).rejects.toThrow(/WardenLike names "Shift", which .*warden\.ts does not export/);

      const inPlace = await extractInterface.run(session, {
        symbol: 'Warden',
        name: 'WardenLike',
      });
      expect(inPlace.newDiagnostics).toEqual([]);
      expect(await preview(inPlace.edit, path.join(FIXTURE, 'src/warden.ts'))).toContain(
        'export interface WardenLike {\n  readonly badge: string;\n  shift(): Shift;\n}',
      );
    },
  );

  it(
    'copies overload signatures and accessors, and joins an existing implements clause',
    { timeout: 60_000 },
    async () => {
      const result = await extractInterface.run(session, { symbol: 'Annex', name: 'AnnexLike' });

      expect(result.members).toEqual(['slots', 'find', 'full']);
      expect(result.newDiagnostics).toEqual([]);

      const text = await preview(result.edit, ANNEX_TS);
      // The implementation signature is not part of the type, so only
      // the two overload signatures are carried.
      expect(text).toContain(`export interface AnnexLike {
  slots: number;
  /** Overloaded on purpose: two signatures and one implementation. */
  find(index: number): string;
  find(label: string): string;
  get full(): boolean;
  set full(value: boolean);
}`);
      expect(text).toContain('export class Annex extends Site implements Located, AnnexLike {');
      expect(text).toContain('export function label(annex: AnnexLike): string {');
    },
  );

  it('warns that inherited members are not carried', { timeout: 60_000 }, async () => {
    const result = await extractInterface.run(session, { symbol: 'Annex', name: 'AnnexLike' });
    expect(result.warnings.join('\n')).toContain(
      'Annex extends a base class, and the interface carries only the members Annex itself declares',
    );
  });

  it("carries the class's type parameters", { timeout: 60_000 }, async () => {
    const result = await extractInterface.run(session, { symbol: 'Crate', name: 'Crated' });

    const text = await preview(result.edit, CRATE_TS);
    expect(text).toContain(`export interface Crated<T> {
  readonly items: T[];
  add(item: T): void;
}`);
    // Measured: `typeParameters.end` addresses the gap before `>`, so
    // anchoring the clause there emits `class Crate<T implements …>`.
    expect(text).toContain('export class Crate<T> implements Crated<T> {');
    // The type arguments at the use site survive the name swap.
    expect(text).toContain('export function first(crate: Crated<string>): string | undefined {');
    expect(result.newDiagnostics).toEqual([]);
  });

  it(
    'generates the interface and nothing else when updateUseSites is off',
    { timeout: 60_000 },
    async () => {
      const result = await extractInterface.run(session, {
        symbol: 'Kennel',
        name: 'Boarding',
        updateUseSites: false,
      });

      expect(result.useSites).toEqual([]);
      expect(result.filesChanged).toEqual([KENNEL_TS]);
      const text = await preview(result.edit, KENNEL_TS);
      expect(text).toContain('export class Kennel implements Boarding {');
      expect(text).toContain('  static open(name: string): Kennel {');
      expect(result.warnings.join('\n')).toContain(
        'nothing about what compiles has changed and every signature still names Kennel',
      );
    },
  );

  it('refuses a class with no eligible members', { timeout: 60_000 }, async () => {
    await expect(
      extractInterface.run(session, { symbol: 'Registry', name: 'RegistryLike' }),
    ).rejects.toThrow(/Registry has no public instance members[\s\S]*unreachable from outside/);
  });

  it('refuses a use site that names the class itself', { timeout: 60_000 }, async () => {
    // `typeof Breeder` is what `new` needs, and no interface can be it.
    await expect(
      extractInterface.run(session, { symbol: 'Breeder', name: 'BreederLike' }),
    ).rejects.toThrow(/writes `typeof Breeder`[\s\S]*no construct signature/);

    // The rest of the extraction is fine, so the escape hatch works.
    const result = await extractInterface.run(session, {
      symbol: 'Breeder',
      name: 'BreederLike',
      updateUseSites: false,
    });
    expect(result.members).toEqual(['kennelName', 'greet']);
    expect(result.newDiagnostics).toEqual([]);
  });

  it(
    'refuses a use site reading a member the interface does not carry',
    { timeout: 60_000 },
    async () => {
      // `matches(other: Pound)` reads `other.key`, which is private and
      // therefore never on the interface.
      await expect(
        extractInterface.run(session, { symbol: 'Pound', name: 'PoundLike' }),
      ).rejects.toThrow(
        /reads "\.key" off a value this rewrite would retype to PoundLike[\s\S]*private, protected, or static/,
      );

      const result = await extractInterface.run(session, {
        symbol: 'Pound',
        name: 'PoundLike',
        updateUseSites: false,
      });
      expect(await preview(result.edit, POUND_TS)).toContain(
        'export class Pound implements PoundLike {',
      );
    },
  );

  it('refuses a use site reading an inherited member', { timeout: 60_000 }, async () => {
    await expect(
      extractInterface.run(session, { symbol: 'Wing', name: 'WingLike' }),
    ).rejects.toThrow(/reads "\.town"[\s\S]*Wing does not declare "town"/);
  });

  it('names the member to add when the selection excluded it', { timeout: 60_000 }, async () => {
    await expect(
      extractInterface.run(session, { symbol: 'Kennel', name: 'Boarding', members: ['name'] }),
    ).rejects.toThrow(/reads "\.vacancies"[\s\S]*Add "vacancies" to members/);
  });

  it('refuses a member the class does not declare', { timeout: 60_000 }, async () => {
    await expect(
      extractInterface.run(session, {
        symbol: 'Kennel',
        name: 'Boarding',
        members: ['name', 'chew'],
      }),
    ).rejects.toThrow(/no public instance member named "chew"[\s\S]*Available: name, occupancy/);
  });

  it(
    'leaves the guard to catch what the cheap analysis cannot see',
    { timeout: 60_000 },
    async () => {
      // `rating` is read only through `readonly Kennel[]` — a nested
      // annotation, where the binding analysis does not look. The
      // typecheck does, and a non-empty newDiagnostics blocks the apply.
      const result = await extractInterface.run(session, {
        symbol: 'Kennel',
        name: 'Boarding',
        members: ['name', 'occupancy', 'vacancies', 'book', 'tag'],
        apply: true,
      });

      expect(result.applied).toBe(false);
      expect(result.newDiagnostics).toHaveLength(1);
      expect(result.newDiagnostics[0]).toContain(
        "TS2339: Property 'rating' does not exist on type 'Boarding'",
      );
      expect(await readFile(KENNEL_TS, 'utf8')).not.toContain('interface Boarding');
    },
  );

  it('refuses a target that is not a class', { timeout: 60_000 }, async () => {
    await expect(
      extractInterface.run(session, { symbol: 'summarize', name: 'Summary' }),
    ).rejects.toThrow(/targets a class; the declaration here is a FunctionDeclaration/);
  });

  it('refuses a name that is already taken', { timeout: 60_000 }, async () => {
    await expect(
      extractInterface.run(session, { symbol: 'Kennel', name: 'Kennel' }),
    ).rejects.toThrow(/cannot be called "Kennel" too/);
    await expect(
      extractInterface.run(session, { symbol: 'Kennel', name: 'Tag' }),
    ).rejects.toThrow(/"Tag" already means something else/);
    await expect(
      extractInterface.run(session, { symbol: 'Kennel', name: '2Legit' }),
    ).rejects.toThrow(/is not a legal interface name/);
  });

  it('drops defaults nested inside a destructured parameter', { timeout: 30_000 }, async () => {
    // A signature cannot hold a parameter initializer. The outer `= {}`
    // becomes `?`, but the `= 0` and `= 20` inside the pattern are
    // initializers too — one TS2371 each. Found on the first real class
    // this met.
    const result = await extractInterface.run(session, {
      symbol: 'Buffer',
      file: 'src/buffer.ts',
      name: 'Buffered',
    });

    expect(result.newDiagnostics).toEqual([]);
    const text = await preview(result.edit, path.join(FIXTURE, 'src/buffer.ts'));
    // In the interface the names stay — they are the documentation —
    // and the defaults go.
    expect(text).toContain(
      'recent({ minLevel, limit }?: { minLevel?: number; limit?: number }): Entry[];',
    );
    // The class keeps them: that is where the defaults actually apply.
    expect(text).toContain('recent({ minLevel = 0, limit = 20 }');
  });
});

describe('ts/refactors/extract-interface apply mode', () => {
  it(
    'writes the interface into a new module and leaves the project clean',
    { timeout: 120_000 },
    async () => {
      await withProjectCopy(FIXTURE, async (copy, root) => {
        const result = await extractInterface.run(copy, {
          symbol: 'Kennel',
          name: 'Boarding',
          targetFile: 'src/boarding.ts',
          apply: true,
        });

        expect(result.applied).toBe(true);
        expect(result.newDiagnostics).toEqual([]);

        expect(await readFile(path.join(root, 'src/boarding.ts'), 'utf8')).toBe(
          `import type { Tag } from './shapes.js';\n\n${KENNEL_INTERFACE}\n`,
        );
        expect(await readFile(path.join(root, 'src/kennel.ts'), 'utf8')).toContain(
          'export class Kennel implements Boarding {',
        );
        expect(await readFile(path.join(root, 'src/report.ts'), 'utf8')).toBe(
          `import type { Boarding } from './boarding.js';\n\n` +
            `export function report(kennel: Boarding): string {\n` +
            `  const { name, occupancy } = kennel;\n` +
            '  return `${name} has ${String(occupancy)} dogs`;\n' +
            `}\n`,
        );

        expect(await diagnosticsOfWrittenProject(root)).toEqual([]);
      });
    },
  );

  it('writes the interface beside the class it came from', { timeout: 120_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await extractInterface.run(copy, {
        symbol: 'Crate',
        name: 'Crated',
        apply: true,
      });

      expect(result.applied).toBe(true);
      const text = await readFile(path.join(root, 'src/crate.ts'), 'utf8');
      expect(text.startsWith('export interface Crated<T> {')).toBe(true);
      expect(text).toContain('export class Crate<T> implements Crated<T> {');

      expect(await diagnosticsOfWrittenProject(root)).toEqual([]);
    });
  });
});

describe('ts/refactors/extract-interface fixture is stable', () => {
  it('leaves the fixture untouched after dry runs', async () => {
    expect(await readFile(KENNEL_TS, 'utf8')).toContain('export class Kennel {');
    expect(await readFile(CONSUMER_TS, 'utf8')).toContain(
      "import { Kennel } from './kennel.js';",
    );
  });

});
