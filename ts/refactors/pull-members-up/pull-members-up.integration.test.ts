import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { pullMembersUp } from './pull-members-up.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/pull-members-up-ts');
const src = (file: string) => path.join(FIXTURE, 'src', file);

describe('ts/refactors/pull-members-up into a base class', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('moves a member up, carrying the import its body needs', { timeout: 30_000 }, async () => {
    const before = await readFile(src('circle.ts'), 'utf8');
    const result = await pullMembersUp.run(session, {
      symbol: 'Circle',
      members: ['reach'],
      to: 'Shape',
    });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics).toEqual([]);
    expect(result.members).toEqual(['reach']);

    // The base gains the whole member, JSDoc included, and the name its
    // body needs — folded into the import geometry.ts already had from
    // that module rather than written as a second statement for it.
    expect(await preview(result.edit, src('geometry.ts'))).toBe(
      "import { ORIGIN, distance } from './point.js';\n" +
        '\n' +
        '/** Everything the renderer needs from a shape. */\n' +
        'export abstract class Shape {\n' +
        '  constructor(\n' +
        '    readonly originX: number,\n' +
        '    readonly originY: number,\n' +
        '  ) {}\n' +
        '\n' +
        '  abstract area(): number;\n' +
        '\n' +
        '  /** Where the shape sits, for logs. */\n' +
        '  label(): string {\n' +
        '    return `shape at ${this.originX},${this.originY}`;\n' +
        '  }\n' +
        '\n' +
        '  /** Whether the shape sits at the canvas origin. */\n' +
        '  atOrigin(): boolean {\n' +
        '    return this.originX === ORIGIN.x && this.originY === ORIGIN.y;\n' +
        '  }\n' +
        '\n' +
        "  /** Distance from the shape's origin to a point on the canvas. */\n" +
        '  reach(x: number, y: number): number {\n' +
        '    return distance(this.originX, this.originY, x, y);\n' +
        '  }\n' +
        '}\n',
    );

    // The derived class loses the member and the import that only it
    // used; `Point` stays, because `edge` still names it.
    const circle = await preview(result.edit, src('circle.ts'));
    expect(circle).toContain("import { type Point } from './point.js';");
    expect(circle).not.toContain('reach(x: number, y: number)');
    expect(circle).toContain('  edge(bearing: number): Point {');

    // Nothing else is touched: inheritance keeps every call resolving,
    // so render.ts, which calls circle.reach(0, 0), needs no edit.
    expect(result.filesChanged.map((file) => path.basename(file)).sort()).toEqual([
      'circle.ts',
      'geometry.ts',
    ]);

    expect(await readFile(src('circle.ts'), 'utf8')).toBe(before);
  });

  it('reports the siblings that keep their own version', { timeout: 30_000 }, async () => {
    const result = await pullMembersUp.run(session, {
      symbol: 'Circle',
      members: ['reach'],
      to: 'Shape',
    });

    // Rectangle is the other subclass of Shape declaring `reach`. Its
    // declaration is left alone — deleting it would change which body
    // runs for rectangles — but the pulled-up one is dead there.
    expect(
      result.siblings.map((sibling) => ({
        container: sibling.container,
        file: path.basename(sibling.file),
        line: sibling.line,
      })),
    ).toEqual([{ container: 'Rectangle', file: 'rectangle.ts', line: 18 }]);
    expect(result.warnings.join('\n')).toMatch(
      /Rectangle .*rectangle\.ts:19.*never runs for them/s,
    );
  });

  it('pulls up several members at once', { timeout: 30_000 }, async () => {
    // Two adjacent members and a class emptied by their removal: the
    // removal spans must not overlap and must not leave a blank line
    // under the opening brace.
    const result = await pullMembersUp.run(session, {
      symbol: 'FileSink',
      members: ['write', 'pending'],
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.members).toEqual(['write', 'pending']);
    expect(result.filesChanged.map((file) => path.basename(file))).toEqual(['log.ts']);
    expect(await preview(result.edit, src('log.ts'))).toBe(
      'export class Sink {\n' +
        '  protected lines: string[] = [];\n' +
        '\n' +
        '  /** Everything buffered so far, as one string. */\n' +
        '  flush(): string {\n' +
        "    return this.lines.join('\\n');\n" +
        '  }\n' +
        '\n' +
        '  /** Adds one line to the buffer. */\n' +
        '  write(line: string): void {\n' +
        '    this.lines.push(line);\n' +
        '  }\n' +
        '\n' +
        '  /** Number of buffered lines. */\n' +
        '  get pending(): number {\n' +
        '    return this.lines.length;\n' +
        '  }\n' +
        '}\n' +
        '\n' +
        'export class FileSink extends Sink {\n' +
        '}\n',
    );
  });

  it('takes the only supertype when `to` is left out', { timeout: 30_000 }, async () => {
    const result = await pullMembersUp.run(session, { symbol: 'Rectangle', members: ['offset'] });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.siblings).toEqual([]);
    expect(await preview(result.edit, src('geometry.ts'))).toContain(
      '  /** How far the shape sits from the canvas origin. */\n' +
        '  offset(): number {\n' +
        '    return Math.abs(this.originX) + Math.abs(this.originY);\n' +
        '  }\n',
    );
    expect(await preview(result.edit, src('rectangle.ts'))).not.toContain('offset()');
  });

  it('writes a fresh import when the base names no such module', { timeout: 30_000 }, async () => {
    // `round2` comes from a module geometry.ts does not import, so the
    // statement lands after the last import rather than folding.
    const result = await pullMembersUp.run(session, {
      symbol: 'Rectangle',
      members: ['offsetLabel'],
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('geometry.ts'))).toContain(
      "import { ORIGIN } from './point.js';\nimport { round2 } from './round.js';\n",
    );
    // Nothing in rectangle.ts names round2 any more, so its import goes.
    expect(await preview(result.edit, src('rectangle.ts'))).toBe(
      "import { Shape } from './geometry.js';\n" +
        '\n' +
        'export class Rectangle extends Shape {\n' +
        '  constructor(\n' +
        '    originX: number,\n' +
        '    originY: number,\n' +
        '    readonly width: number,\n' +
        '    readonly height: number,\n' +
        '  ) {\n' +
        '    super(originX, originY);\n' +
        '  }\n' +
        '\n' +
        '  area(): number {\n' +
        '    return this.width * this.height;\n' +
        '  }\n' +
        '\n' +
        '  /** Rectangles measure reach from their far corner. */\n' +
        '  reach(x: number, y: number): number {\n' +
        '    return Math.abs(x - this.originX) + Math.abs(y - this.originY);\n' +
        '  }\n' +
        '\n' +
        '  /** How far the shape sits from the canvas origin. */\n' +
        '  offset(): number {\n' +
        '    return Math.abs(this.originX) + Math.abs(this.originY);\n' +
        '  }\n' +
        '\n' +
        '  /** One origin coordinate, chosen at runtime. */\n' +
        "  originOf(key: 'originX' | 'originY'): number {\n" +
        '    return this[key];\n' +
        '  }\n' +
        '\n' +
        "  /** The shape's label, shouted. */\n" +
        '  shout(): string {\n' +
        '    return `${super.label()}!`;\n' +
        '  }\n' +
        '}\n',
    );
  });

  it('warns about a member read through a computed key', { timeout: 30_000 }, async () => {
    const result = await pullMembersUp.run(session, { symbol: 'Rectangle', members: ['originOf'] });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/computed key at .*rectangle\.ts:35/);
  });

  it('carries a static, and says why no call site changed', { timeout: 30_000 }, async () => {
    const result = await pullMembersUp.run(session, {
      symbol: 'Circle',
      members: ['unit'],
      to: 'Shape',
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('geometry.ts'))).toContain(
      "  /** The unit every shape measures in. */\n  static readonly unit = 'px';\n",
    );
    expect(result.warnings.join('\n')).toContain('static members are inherited');
  });
});

describe('ts/refactors/pull-members-up as a signature', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('leaves an abstract declaration and the body where it was', { timeout: 30_000 }, async () => {
    const result = await pullMembersUp.run(session, {
      symbol: 'Circle',
      members: ['reach'],
      to: 'Shape',
      asAbstract: true,
    });

    expect(result.newDiagnostics).toEqual([]);
    // Only the base changes: the implementation does not move, so the
    // derived class is not edited at all.
    expect(result.filesChanged.map((file) => path.basename(file))).toEqual(['geometry.ts']);
    expect(await preview(result.edit, src('geometry.ts'))).toContain(
      "  /** Distance from the shape's origin to a point on the canvas. */\n" +
        '  abstract reach(x: number, y: number): number;\n',
    );
    expect(result.warnings.join('\n')).toContain('Circle keeps every body');
  });

  it('copies only the signature into an interface, with the types it names', { timeout: 30_000 }, async () => {
    const result = await pullMembersUp.run(session, {
      symbol: 'Circle',
      members: ['edge'],
      to: 'Drawable',
      asAbstract: true,
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.filesChanged.map((file) => path.basename(file))).toEqual(['drawable.ts']);
    // `Point` is not in drawable.ts's scope, so the signature brings its
    // own type-only import.
    expect(await preview(result.edit, src('drawable.ts'))).toBe(
      "import type { Point } from './point.js';\n" +
        '\n' +
        '/** Anything the renderer can put on a canvas. */\n' +
        'export interface Drawable {\n' +
        '  area(): number;\n' +
        '\n' +
        "  /** Where the shape's edge sits on a bearing. */\n" +
        '  edge(bearing: number): Point;\n' +
        '}\n',
    );
    expect(result.warnings.join('\n')).toContain('a class is checked against what it implements');
  });

  it('refuses to move a member into an interface', { timeout: 30_000 }, async () => {
    await expect(
      pullMembersUp.run(session, { symbol: 'Circle', members: ['edge'], to: 'Drawable' }),
    ).rejects.toThrow(/holds no implementations[\s\S]*asAbstract: true/);
  });

  it('refuses an abstract declaration on a concrete base', { timeout: 30_000 }, async () => {
    await expect(
      pullMembersUp.run(session, { symbol: 'FileSink', members: ['write'], asAbstract: true }),
    ).rejects.toThrow(/Sink is not an abstract class/);
  });

  it('refuses a private or static abstract declaration', { timeout: 30_000 }, async () => {
    await expect(
      pullMembersUp.run(session, {
        symbol: 'Circle',
        members: ['precision'],
        to: 'Shape',
        asAbstract: true,
      }),
    ).rejects.toThrow(/`private abstract` is not a legal member/);
    await expect(
      pullMembersUp.run(session, {
        symbol: 'Circle',
        members: ['unit'],
        to: 'Shape',
        asAbstract: true,
      }),
    ).rejects.toThrow(/static member cannot be abstract/);
  });

  it('refuses a static in an interface', { timeout: 30_000 }, async () => {
    await expect(
      pullMembersUp.run(session, { symbol: 'Circle', members: ['unit'], to: 'Drawable' }),
    ).rejects.toThrow(/an interface describes instances/);
  });
});

describe('ts/refactors/pull-members-up refusals', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('refuses a member that reads state the base does not declare', { timeout: 30_000 }, async () => {
    // `radius` is a parameter property on Circle, so `this.radius` in
    // the base would be TS2339 somewhere the caller did not edit.
    await expect(
      pullMembersUp.run(session, { symbol: 'Circle', members: ['edge'], to: 'Shape' }),
    ).rejects.toThrow(/reads `this\.radius`, which Shape does not declare/);
  });

  it('refuses a member that reads private state staying behind', { timeout: 30_000 }, async () => {
    await expect(
      pullMembersUp.run(session, { symbol: 'Circle', members: ['rounded'], to: 'Shape' }),
    ).rejects.toThrow(/`this\.precision`, which is private to Circle and stays there/);
  });

  it('refuses a member that reads #-private state', { timeout: 30_000 }, async () => {
    await expect(
      pullMembersUp.run(session, { symbol: 'Circle', members: ['stamp'], to: 'Shape' }),
    ).rejects.toThrow(/A #-private name is scoped to the class body that declares it/);
  });

  it('refuses a #-private member as the target', { timeout: 30_000 }, async () => {
    await expect(
      pullMembersUp.run(session, { symbol: 'Circle', members: ['#serial'], to: 'Shape' }),
    ).rejects.toThrow(/is a #private member/);
  });

  it('refuses a member reaching `super`', { timeout: 30_000 }, async () => {
    await expect(
      pullMembersUp.run(session, { symbol: 'Rectangle', members: ['shout'] }),
    ).rejects.toThrow(/reaches `super`/);
  });

  it("refuses a type the base's file cannot name", { timeout: 30_000 }, async () => {
    // `Sector` is declared in circle.ts and not exported, so geometry.ts
    // has no way to refer to it.
    await expect(
      pullMembersUp.run(session, { symbol: 'Circle', members: ['slice'], to: 'Shape' }),
    ).rejects.toThrow(/names "Sector", which .*circle\.ts does not export/);
  });

  it('refuses a name the destination already declares', { timeout: 30_000 }, async () => {
    await expect(
      pullMembersUp.run(session, { symbol: 'Circle', members: ['area'], to: 'Shape' }),
    ).rejects.toThrow(/Shape already declares "area"/);
  });

  it('refuses a hierarchy the checker cannot close', { timeout: 30_000 }, async () => {
    // Overlay's base is a mixin call, so a declaration of `announce`
    // under Widget could be invisible.
    await expect(
      pullMembersUp.run(session, { symbol: 'Panel', members: ['announce'] }),
    ).rejects.toThrow(/hierarchy cannot be closed \(Overlay extends withLogging\(Widget\)\)/);
  });

  it('refuses a base this project cannot write to', { timeout: 30_000 }, async () => {
    await expect(
      pullMembersUp.run(session, { symbol: 'Plugin', members: ['label'] }),
    ).rejects.toThrow(/vendor\.d\.ts, a declaration file/);
  });

  it('refuses a decorated member', { timeout: 30_000 }, async () => {
    await expect(
      pullMembersUp.run(session, { symbol: 'TimedJob', members: ['run'] }),
    ).rejects.toThrow(/is decorated/);
  });

  it('refuses a member already marked override', { timeout: 30_000 }, async () => {
    await expect(
      pullMembersUp.run(session, { symbol: 'TimedJob', members: ['name'] }),
    ).rejects.toThrow(/marked `override`/);
  });

  it('refuses an ambiguous or unknown destination', { timeout: 30_000 }, async () => {
    await expect(
      pullMembersUp.run(session, { symbol: 'Circle', members: ['reach'] }),
    ).rejects.toThrow(/more than one supertype \(Shape \(extends\), Drawable \(implements\)\)/);
    await expect(
      pullMembersUp.run(session, { symbol: 'Circle', members: ['reach'], to: 'Nowhere' }),
    ).rejects.toThrow(/does not inherit from "Nowhere"/);
  });

  it('refuses a class with nothing above it, and a base it cannot resolve', { timeout: 30_000 }, async () => {
    await expect(
      pullMembersUp.run(session, { symbol: 'Widget', members: ['paint'] }),
    ).rejects.toThrow(/extends nothing and implements nothing/);
    await expect(
      pullMembersUp.run(session, { symbol: 'Overlay', members: ['announce'] }),
    ).rejects.toThrow(/supertypes cannot be resolved/);
  });

  it('refuses a target that is not a class, and members that are not there', { timeout: 30_000 }, async () => {
    await expect(
      pullMembersUp.run(session, { symbol: 'Drawable', members: ['area'] }),
    ).rejects.toThrow(/targets a class/);
    await expect(
      pullMembersUp.run(session, { symbol: 'Circle', members: ['nope'], to: 'Shape' }),
    ).rejects.toThrow(/declares no member named "nope"/);
    await expect(
      pullMembersUp.run(session, { symbol: 'Circle', members: [], to: 'Shape' }),
    ).rejects.toThrow(/name at least one member/);
  });

  it('refuses an edit the typecheck rejects', { timeout: 30_000 }, async () => {
    // A private field pulled onto the base is private *there*, so the
    // class it left can no longer read it. Nothing before the edit
    // knows that; the guard does, and it blocks apply.
    const result = await pullMembersUp.run(session, {
      symbol: 'Circle',
      members: ['precision'],
      to: 'Shape',
      apply: true,
    });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics.join('\n')).toContain('TS2341');
    expect(await readFile(src('circle.ts'), 'utf8')).toContain('private precision = 2;');
  });

  it('refuses an abstract declaration a sibling cannot satisfy', { timeout: 30_000 }, async () => {
    // Shape gains `abstract offset()`, and Circle — a concrete subclass
    // that never declared one — stops compiling. The warning says this
    // will happen; the guard proves it did.
    const result = await pullMembersUp.run(session, {
      symbol: 'Rectangle',
      members: ['offset'],
      asAbstract: true,
      apply: true,
    });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics.join('\n')).toContain('TS2515');
  });
});

describe('ts/refactors/pull-members-up apply mode', () => {
  it('writes the pull-up to disk, leaving the project compiling', { timeout: 60_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const file = (name: string) => path.join(root, 'src', name);
      const result = await pullMembersUp.run(copy, {
        symbol: 'Circle',
        members: ['reach'],
        to: 'Shape',
        apply: true,
      });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.applied).toBe(true);
      expect(await readFile(file('geometry.ts'), 'utf8')).toContain(
        '  reach(x: number, y: number): number {',
      );
      expect(await readFile(file('circle.ts'), 'utf8')).not.toContain('reach(x: number');
      // The call site never moved and never had to.
      expect(await readFile(file('render.ts'), 'utf8')).toContain('circle.reach(0, 0)');

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

      // The session must see the project as it now is: Circle no longer
      // declares the member it used to.
      await expect(
        pullMembersUp.run(copy, { symbol: 'Circle', members: ['reach'], to: 'Shape' }),
      ).rejects.toThrow(/declares no member named "reach"/);
    });
  });
});
