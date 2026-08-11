import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { extractSuperclass } from './extract-superclass.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/extract-superclass-ts');
const KENNEL_TS = path.join(FIXTURE, 'src/kennel.ts');
const BOARDING_TS = path.join(FIXTURE, 'src/boarding.ts');
const POUND_TS = path.join(FIXTURE, 'src/pound.ts');
const FRONT_DESK_TS = path.join(FIXTURE, 'src/front-desk.ts');
const CRATE_TS = path.join(FIXTURE, 'src/crate.ts');
const HOLDING_TS = path.join(FIXTURE, 'src/holding.ts');

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

describe('ts/refactors/extract-superclass', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('pulls members into a base class in the same file', { timeout: 60_000 }, async () => {
    const result = await extractSuperclass.run(session, {
      symbol: 'Kennel',
      name: 'Occupancy',
      members: ['occupancy', 'admit', 'release'],
    });

    expect(result.members).toEqual(['occupancy', 'admit', 'release']);
    expect(result.newDiagnostics).toEqual([]);
    // The point of this refactoring: no other file is touched, because
    // inheritance keeps every call site resolving.
    expect(result.filesChanged).toEqual([KENNEL_TS]);

    expect(await preview(result.edit, KENNEL_TS)).toBe(
      `import type { Counted, Tag } from './shapes.js';

export class Occupancy {
  /** Dogs currently boarding. */
  occupancy = 0;

  /** Takes one more dog, returning the new occupancy. */
  admit(): number {
    this.occupancy += 1;
    return this.occupancy;
  }

  release(): number {
    this.occupancy -= 1;
    return this.occupancy;
  }
}

/** A boarding kennel with a fixed number of runs. */
export class Kennel extends Occupancy implements Counted {
  private ledger: string[] = [];

  readonly name: string;

  constructor(name: string) {
    super();
    this.name = name;
  }

  book(dog: string): Tag {
    this.ledger.push(dog);
    this.admit();
    return { label: dog };
  }

  get roster(): readonly string[] {
    return this.ledger;
  }
}
`,
    );
  });

  it('reports the super() call and the interface it still satisfies', { timeout: 60_000 }, async () => {
    const result = await extractSuperclass.run(session, {
      symbol: 'Kennel',
      name: 'Occupancy',
      members: ['occupancy', 'admit', 'release'],
    });
    const warnings = result.warnings.join('\n');
    expect(warnings).toContain("`super()` was added to Kennel's constructor");
    expect(warnings).toContain('Kennel.occupancy also satisfies Counted');
  });

  it(
    'puts the base in another module, importing what its code names',
    { timeout: 60_000 },
    async () => {
      const result = await extractSuperclass.run(session, {
        symbol: 'Kennel',
        name: 'Boarding',
        members: ['occupancy', 'ledger', 'admit', 'book'],
        targetFile: 'src/boarding.ts',
      });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.edit.fileOps).toEqual([{ kind: 'create', file: BOARDING_TS }]);
      expect(result.filesChanged).toEqual([BOARDING_TS, KENNEL_TS]);

      // `Tag` is named only by `book`, which is leaving, so the base
      // imports it and the class file stops doing so.
      expect(await preview(result.edit, BOARDING_TS)).toBe(
        `import type { Tag } from './shapes.js';

export class Boarding {
  /** Dogs currently boarding. */
  occupancy = 0;

  protected ledger: string[] = [];

  /** Takes one more dog, returning the new occupancy. */
  admit(): number {
    this.occupancy += 1;
    return this.occupancy;
  }

  book(dog: string): Tag {
    this.ledger.push(dog);
    this.admit();
    return { label: dog };
  }
}
`,
      );

      expect(await preview(result.edit, KENNEL_TS)).toBe(
        `import type { Counted } from './shapes.js';
import { Boarding } from './boarding.js';

/** A boarding kennel with a fixed number of runs. */
export class Kennel extends Boarding implements Counted {
  readonly name: string;

  constructor(name: string) {
    super();
    this.name = name;
  }

  release(): number {
    this.occupancy -= 1;
    return this.occupancy;
  }

  get roster(): readonly string[] {
    return this.ledger;
  }
}
`,
      );
    },
  );

  it('promotes a private member the subclass still reads', { timeout: 60_000 }, async () => {
    const result = await extractSuperclass.run(session, {
      symbol: 'Kennel',
      name: 'Boarding',
      members: ['occupancy', 'ledger', 'admit', 'book'],
      targetFile: 'src/boarding.ts',
    });
    expect(result.warnings.join('\n')).toContain(
      'Boarding.ledger was promoted from private to protected',
    );
  });

  it('needs no super() where the class declares no constructor', { timeout: 60_000 }, async () => {
    const result = await extractSuperclass.run(session, {
      symbol: 'Pound',
      name: 'Straying',
      members: ['strays'],
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.warnings).toEqual([]);
    const text = await preview(result.edit, POUND_TS);
    expect(text).toContain('export class Straying {\n  strays = 0;\n}');
    expect(text).toContain('export class Pound extends Straying {\n  /** Dogs scanned');
    expect(text).not.toContain('super();');
  });

  it('leaves every call site alone', { timeout: 60_000 }, async () => {
    const before = await readFile(FRONT_DESK_TS, 'utf8');
    const result = await extractSuperclass.run(session, {
      symbol: 'Kennel',
      name: 'Boarding',
      members: ['occupancy', 'ledger', 'admit', 'book'],
      targetFile: 'src/boarding.ts',
    });
    expect(result.edit.changes[FRONT_DESK_TS]).toBeUndefined();
    expect(await preview(result.edit, FRONT_DESK_TS)).toBe(before);
  });

  it(
    'carries the type parameters the moved code uses, and both halves of an accessor pair',
    { timeout: 60_000 },
    async () => {
      const result = await extractSuperclass.run(session, {
        // Named out of order: the base reads in declaration order.
        members: ['first', 'add', 'items'],
        symbol: 'Crate',
        name: 'Held',
        targetFile: 'src/holding.ts',
      });

      expect(result.members).toEqual(['items', 'add', 'first']);
      expect(result.newDiagnostics).toEqual([]);
      // holding.ts exists already, so the base is appended to it and
      // CRATE_LIMIT — declared there — needs no import.
      expect(result.edit.fileOps).toBeUndefined();
      expect(await preview(result.edit, HOLDING_TS)).toBe(
        `import type { Tag } from './shapes.js';

/** How many things one crate holds. */
export const CRATE_LIMIT = 12;

export class Held<T extends Tag> {
  items: T[] = [];

  /** Adds one, returning the new size. */
  add(item: T): number {
    if (this.items.length >= CRATE_LIMIT) throw new Error('crate is full');
    this.items.push(item);
    return this.items.length;
  }

  get first(): T | undefined {
    return this.items[0];
  }

  set first(value: T | undefined) {
    if (value) this.items[0] = value;
  }
}
`,
      );

      // `CRATE_LIMIT` was named only by `add`, so its import goes with
      // it and the base class import takes its place.
      expect(await preview(result.edit, CRATE_TS)).toBe(
        `import type { Tag } from './shapes.js';
import { Held } from './holding.js';

/** A crate of tagged things. */
export class Crate<T extends Tag> extends Held<T> {
  labels(): string {
    return this.items.map((item) => item.label).join(',');
  }
}
`,
      );
    },
  );

  it('lets the guard refuse a member that hands `this` out', { timeout: 60_000 }, async () => {
    // Nothing in the analysis above sees this: `report` reads no member
    // through `this`, it passes `this` to something typed as the whole
    // class. The base is not that class, so it is TS2345 with the edit
    // applied — and a non-empty newDiagnostics blocks the apply.
    const result = await extractSuperclass.run(session, {
      symbol: 'Pound',
      name: 'Reporting',
      members: ['report'],
      apply: true,
    });
    expect(result.applied).toBe(false);
    expect(result.newDiagnostics.join('\n')).toContain('TS2345');
  });

  describe('refusals', () => {
    it('refuses a class that already extends something', { timeout: 60_000 }, async () => {
      await expect(
        extractSuperclass.run(session, { symbol: 'CityPound', name: 'Scanning', members: ['scan'] }),
      ).rejects.toThrow(/already extends Pound.*single-inheritance.*exactly one base/s);
    });

    it('refuses a member another class in the hierarchy declares', { timeout: 60_000 }, async () => {
      await expect(
        extractSuperclass.run(session, { symbol: 'Pound', name: 'Scanning', members: ['scan'] }),
      ).rejects.toThrow(/Pound\.scan is also declared by CityPound/);
    });

    it('refuses a static member', { timeout: 60_000 }, async () => {
      await expect(
        extractSuperclass.run(session, { symbol: 'Clinic', name: 'Practice', members: ['OPENING'] }),
      ).rejects.toThrow(/Clinic\.OPENING is static.*reached through the class name/s);
    });

    it('refuses a #private member', { timeout: 60_000 }, async () => {
      await expect(
        extractSuperclass.run(session, { symbol: 'Clinic', name: 'Practice', members: ['#chart'] }),
      ).rejects.toThrow(/#private member.*invisible everywhere else/s);
      // Named without its hash it is the same member, so the refusal is
      // about privacy rather than about spelling.
      await expect(
        extractSuperclass.run(session, { symbol: 'Clinic', name: 'Practice', members: ['chart'] }),
      ).rejects.toThrow(/#private member/);
    });

    it('refuses the constructor', { timeout: 60_000 }, async () => {
      await expect(
        extractSuperclass.run(session, {
          symbol: 'Clinic',
          name: 'Practice',
          members: ['constructor'],
        }),
      ).rejects.toThrow(/constructor cannot be pulled up/);
    });

    it('refuses a constructor parameter property', { timeout: 60_000 }, async () => {
      await expect(
        extractSuperclass.run(session, { symbol: 'Clinic', name: 'Practice', members: ['vetName'] }),
      ).rejects.toThrow(/"vetName" is a constructor parameter property/);
    });

    it('names the members that would have to travel too', { timeout: 60_000 }, async () => {
      await expect(
        extractSuperclass.run(session, { symbol: 'Clinic', name: 'Practice', members: ['record'] }),
      ).rejects.toThrow(/this\.#chart, this\.visits, which would stay on Clinic/);
    });

    it('refuses a member that reads a static of the class it leaves', { timeout: 60_000 }, async () => {
      await expect(
        extractSuperclass.run(session, { symbol: 'Clinic', name: 'Practice', members: ['opensAt'] }),
      ).rejects.toThrow(/Clinic\.OPENING is read at .*depend on its own subclass/s);
    });

    it('refuses a property the constructor initializes', { timeout: 60_000 }, async () => {
      await expect(
        extractSuperclass.run(session, { symbol: 'Kennel', name: 'Named', members: ['name'] }),
      ).rejects.toThrow(/Kennel\.name is readonly and assigned at/);
    });

    it('refuses a member the class does not declare', { timeout: 60_000 }, async () => {
      await expect(
        extractSuperclass.run(session, { symbol: 'Kennel', name: 'Boarding', members: ['kennels'] }),
      ).rejects.toThrow(/declares no member named "kennels"\. Available: occupancy, ledger/);
    });

    it('refuses a target that is not a class', { timeout: 60_000 }, async () => {
      await expect(
        extractSuperclass.run(session, { symbol: 'checkIn', name: 'Desk', members: ['x'] }),
      ).rejects.toThrow(/targets a class; the declaration here is a FunctionDeclaration/);
    });

    it('refuses a name that already means something', { timeout: 60_000 }, async () => {
      await expect(
        extractSuperclass.run(session, {
          symbol: 'Kennel',
          name: 'Counted',
          members: ['occupancy'],
        }),
      ).rejects.toThrow(/"Counted" already means something else/);
      await expect(
        extractSuperclass.run(session, { symbol: 'Kennel', name: 'Kennel', members: ['occupancy'] }),
      ).rejects.toThrow(/cannot be called "Kennel" too/);
    });

    it('refuses an empty member list', { timeout: 60_000 }, async () => {
      await expect(
        extractSuperclass.run(session, { symbol: 'Kennel', name: 'Boarding', members: [] }),
      ).rejects.toThrow(/members is required/);
    });
  });

  it(
    'applies to disk and the reopened project typechecks clean',
    { timeout: 120_000 },
    async () => {
      await withProjectCopy(FIXTURE, async (copy, root) => {
        const result = await extractSuperclass.run(copy, {
          symbol: 'Kennel',
          name: 'Boarding',
          members: ['occupancy', 'ledger', 'admit', 'book'],
          targetFile: 'src/boarding.ts',
          apply: true,
        });

        expect(result.applied).toBe(true);
        expect(result.newDiagnostics).toEqual([]);

        const written = await readFile(path.join(root, 'src/boarding.ts'), 'utf8');
        expect(written).toContain('export class Boarding {');
        expect(written).toContain('  protected ledger: string[] = [];');
        const kennel = await readFile(path.join(root, 'src/kennel.ts'), 'utf8');
        expect(kennel).toContain('export class Kennel extends Boarding implements Counted {');
        expect(kennel).toContain('    super();');

        expect(await diagnosticsOfWrittenProject(root)).toEqual([]);
      });
    },
  );

  it(
    'applies a same-file extraction and the reopened project typechecks clean',
    { timeout: 120_000 },
    async () => {
      await withProjectCopy(FIXTURE, async (copy, root) => {
        const result = await extractSuperclass.run(copy, {
          symbol: 'Kennel',
          name: 'Occupancy',
          members: ['occupancy', 'admit', 'release'],
          apply: true,
        });

        expect(result.applied).toBe(true);
        expect(await diagnosticsOfWrittenProject(root)).toEqual([]);
      });
    },
  );

  it(
    'applies into an existing module and the reopened project typechecks clean',
    { timeout: 120_000 },
    async () => {
      await withProjectCopy(FIXTURE, async (copy, root) => {
        const result = await extractSuperclass.run(copy, {
          symbol: 'Crate',
          name: 'Held',
          members: ['items', 'add', 'first'],
          targetFile: 'src/holding.ts',
          apply: true,
        });

        expect(result.applied).toBe(true);
        const holding = await readFile(path.join(root, 'src/holding.ts'), 'utf8');
        expect(holding).toContain('export class Held<T extends Tag> {');
        expect(await diagnosticsOfWrittenProject(root)).toEqual([]);
      });
    },
  );
});
