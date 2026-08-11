import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { enumToConstObject } from './enum-to-const-object.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/enum-to-const-object-ts');
const COLOR_TS = path.join(FIXTURE, 'src/color.ts');
const DIR_TS = path.join(FIXTURE, 'src/dir.ts');
const FLAGS_TS = path.join(FIXTURE, 'src/flags.ts');
const ODD_TS = path.join(FIXTURE, 'src/odd.ts');
const PALETTE_TS = path.join(FIXTURE, 'src/palette.ts');

/**
 * Every diagnostic in a project opened fresh from disk. An authored
 * edit that merely looks right — a type alias in the wrong scope, a
 * member the object literal spells differently — shows up here and
 * nowhere in the tool's own output.
 */
async function diagnosticsOnDisk(root: string): Promise<string[]> {
  const session = TsProjectSession.open(root);
  try {
    const program = session.program();
    return program
      .getSourceFiles()
      .filter((file) => path.resolve(file.fileName).startsWith(root))
      .flatMap((file) => [
        ...program.getSyntacticDiagnostics(file),
        ...program.getSemanticDiagnostics(file),
      ])
      .map(
        (diagnostic) =>
          `${path.basename(diagnostic.file?.fileName ?? '?')}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
      );
  } finally {
    await session.dispose();
  }
}

describe('ts/refactors/enum-to-const-object', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('converts a string enum, keeping its comments and touching only its file', async () => {
    const result = await enumToConstObject.run(session, { symbol: 'Color' });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.filesChanged).toEqual([COLOR_TS]);
    expect(result.members).toEqual([
      { name: 'Red', value: "'red'" },
      { name: 'Blue', value: "'blue'" },
    ]);
    // The body is carried across rather than reprinted, so the member
    // doc comment and the trailing comment survive in place.
    expect(await preview(result.edit, COLOR_TS)).toBe(
      [
        '/** Named colours the renderer understands. */',
        'export const Color = {',
        '  /** The warm one. */',
        "  Red: 'red',",
        "  Blue: 'blue', // the cold one",
        '} as const;',
        'export type Color = (typeof Color)[keyof typeof Color];',
        '',
      ].join('\n'),
    );
    // Nothing else moves: the barrel re-export and the consumer that
    // uses Color as both a value and a type are already correct, which
    // is the reason the value and the type share a name.
    expect(await preview(result.edit, PALETTE_TS)).toBe(await readFile(PALETTE_TS, 'utf8'));
  });

  it('always warns that the converted type stops being nominal', async () => {
    const result = await enumToConstObject.run(session, { symbol: 'Color' });

    // The guard cannot report this: losing nominality only ever makes
    // more code compile, and the guard compares diagnostics.
    expect(result.warnings[0]).toContain('An enum type is nominal');
    expect(result.warnings.join('\n')).toContain('it reports diagnostics the edit introduces');
  });

  it('numbers the members of an auto-numbered enum and warns about the runtime object', async () => {
    const result = await enumToConstObject.run(session, { symbol: 'Dir' });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.members).toEqual([
      { name: 'Up', value: '0' },
      { name: 'Down', value: '1' },
    ]);
    expect(await preview(result.edit, DIR_TS)).toContain(
      ['export const Dir = {', '  Up: 0,', '  Down: 1,', '} as const;'].join('\n'),
    );
    const shape = result.warnings.find((warning) => warning.includes('reverse mapping'));
    expect(shape).toContain('Object.keys(Dir) returned 4 entries');
    expect(shape).toContain('const object returns 2');
    expect(shape).toContain('src/dir.ts:11:44'); // the Object.keys(Dir) call
  });

  it('keeps a nested enum inside its namespace, with odd names and signs intact', async () => {
    const result = await enumToConstObject.run(session, { symbol: 'Edge' });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.members).toEqual([
      { name: 'top-left', value: "'tl'" },
      { name: 'Offset', value: '-1' },
    ]);
    // The indentation is the declaration's own, so the pair lands
    // inside the namespace — where `Layout.Edge` as a type resolves.
    expect(await preview(result.edit, ODD_TS)).toContain(
      [
        '  /** Indented, exported from inside a namespace, and oddly spelled. */',
        '  export const Edge = {',
        "    'top-left': 'tl',",
        '    Offset: -1,',
        '  } as const;',
        '  export type Edge = (typeof Edge)[keyof typeof Edge];',
      ].join('\n'),
    );
  });

  it('converts a one-line enum without reflowing it', async () => {
    const result = await enumToConstObject.run(session, { symbol: 'Terse' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, ODD_TS)).toContain(
      'export const Terse = { On: 1, Off: 0 } as const;\n' +
        'export type Terse = (typeof Terse)[keyof typeof Terse];',
    );
  });

  it('is refused by the compile guard when a numeric member is used as a number', async () => {
    // The bit-flag idiom: `Flags.Read | Flags.Write` has type `number`,
    // which a numeric enum type accepts and a union of literals does
    // not. The edit itself is well-formed — this is the guard doing
    // the refusing, so apply: true still writes nothing.
    const result = await enumToConstObject.run(session, { symbol: 'Flags', apply: true });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics.join('\n')).toContain(
      "Type 'number' is not assignable to type 'Flags'",
    );
    expect(await preview(result.edit, FLAGS_TS)).toContain('export const Flags = {');
    expect(await readFile(FLAGS_TS, 'utf8')).toContain('export enum Flags {');
  });

  it('refuses a const enum, whose whole purpose is having no runtime object', async () => {
    await expect(enumToConstObject.run(session, { symbol: 'Fast' })).rejects.toThrow(
      /"Fast" is a const enum, which has no runtime object to convert/,
    );
  });

  it('refuses a declaration-merged enum, naming what it merges with', async () => {
    await expect(enumToConstObject.run(session, { symbol: 'Level' })).rejects.toThrow(
      /"Level" is declaration-merged with src\/merged\.ts:6 \(ModuleDeclaration\)/,
    );
  });

  it('refuses members whose initializer is not a literal', async () => {
    // Size's two members fold to constants the checker will hand out,
    // and converting them either way is still wrong — see the widening
    // test below. Length's does not fold at all.
    await expect(enumToConstObject.run(session, { symbol: 'Size' })).rejects.toThrow(
      /initializer is not a literal: Small at line 5, Large at line 6/,
    );
    await expect(enumToConstObject.run(session, { symbol: 'Length' })).rejects.toThrow(
      /initializer is not a literal: Short at line 10/,
    );
  });

  it('refuses a reverse-mapping read, and only that read', async () => {
    const refusal = await enumToConstObject
      .run(session, { symbol: 'Rank' })
      .then(() => '', (error: Error) => error.message);

    expect(refusal).toMatch(
      /read through a key that is not a member name[\s\S]*src\/reverse\.ts:8:10 — Rank\[value\]/,
    );
    // `Rank['Bronze']` two lines below it is a forward read a plain
    // object serves identically, and is not among the refusals.
    expect(refusal).not.toContain("Rank['Bronze']");
    expect(refusal).not.toContain('src/reverse.ts:12');
  });

  it('refuses a member used as a type, which needs the enum type namespace', async () => {
    await expect(enumToConstObject.run(session, { symbol: 'Shape' })).rejects.toThrow(
      /members used as types[\s\S]*src\/shape\.ts:8:9 — Shape\.Circle[\s\S]*typeof Shape\.Member/,
    );
  });

  it('refuses a target that is not an enum, and an unknown name', async () => {
    const text = await readFile(PALETTE_TS, 'utf8');
    const line = text.split('\n').findIndex((l) => l.startsWith('export function temperature'));
    await expect(
      enumToConstObject.run(session, {
        file: PALETTE_TS,
        line,
        character: text.split('\n')[line]!.indexOf('temperature'),
      }),
    ).rejects.toThrow(/is a FunctionDeclaration, not an enum/);
    await expect(enumToConstObject.run(session, { symbol: 'NoSuchEnum' })).rejects.toThrow(
      /No declaration named "NoSuchEnum"/,
    );
  });
});

describe('ts/refactors/enum-to-const-object apply mode', () => {
  it('applies across a barrel, leaving every use site alone', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const before = await readFile(path.join(root, 'src/palette.ts'), 'utf8');
      const result = await enumToConstObject.run(copy, { symbol: 'Color', apply: true });

      expect(result.applied).toBe(true);
      expect(result.newDiagnostics).toEqual([]);
      expect(result.filesChanged).toEqual([path.join(root, 'src/color.ts')]);

      const color = await readFile(path.join(root, 'src/color.ts'), 'utf8');
      expect(color).toContain("export const Color = {\n  /** The warm one. */\n  Red: 'red',");
      expect(color).toContain('export type Color = (typeof Color)[keyof typeof Color];');
      // `export { Color } from './color.js'` still re-exports both
      // meanings, and the consumer switch still narrows.
      expect(await readFile(path.join(root, 'src/barrel.ts'), 'utf8')).toContain(
        "export { Color } from './color.js';",
      );
      expect(await readFile(path.join(root, 'src/palette.ts'), 'utf8')).toBe(before);

      expect(await diagnosticsOnDisk(root)).toEqual([]);

      // The name now belongs to a const and a type alias, so the tool
      // has nothing left to convert.
      await expect(enumToConstObject.run(copy, { symbol: 'Color' })).rejects.toThrow(
        /is a VariableDeclaration, not an enum/,
      );
    });
  });

  it('applies to a numeric enum whose members are never used as numbers', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await enumToConstObject.run(copy, { symbol: 'Dir', apply: true });

      expect(result.applied).toBe(true);
      expect(result.newDiagnostics).toEqual([]);
      const dir = await readFile(path.join(root, 'src/dir.ts'), 'utf8');
      expect(dir).toContain('export const Dir = {\n  Up: 0,\n  Down: 1,\n} as const;');
      expect(dir).toContain('return dir === Dir.Up ? -1 : 1;');
      expect(await diagnosticsOnDisk(root)).toEqual([]);

      // Green, and still a behaviour change: Object.keys(Dir) returned
      // ['0', '1', 'Up', 'Down'] and now returns ['Up', 'Down'].
      expect(result.warnings.join('\n')).toContain('src/dir.ts:11:44');
    });
  });

  it('measures both conversions of a non-literal initializer, which is why neither is made', async () => {
    await withProjectCopy(FIXTURE, async (_copy, root) => {
      // The measurement behind the refusal: write both conversions of
      // the same two members — the one this tool declines, with the
      // author's expressions kept, and the one it would produce if it
      // folded them to the checker's constants — and ask what each
      // member type became. `as const` narrows literals only.
      const file = path.join(root, 'src/computed.ts');
      await writeFile(
        file,
        [
          'const base = 2;',
          'export const Kept = { Small: base, Large: base * 2 } as const;',
          'export type Kept = (typeof Kept)[keyof typeof Kept];',
          'export const Folded = { Small: 2, Large: 4 } as const;',
          'export type Folded = (typeof Folded)[keyof typeof Folded];',
          '',
        ].join('\n'),
      );

      const session = TsProjectSession.open(root);
      try {
        const source = session.program().getSourceFile(file)!;
        const checker = session.checker();
        const aliasText = (name: string) => {
          const alias = source.statements
            .filter(ts.isTypeAliasDeclaration)
            .find((node) => node.name.text === name)!;
          return checker.typeToString(
            checker.getTypeAtLocation(alias.name),
            undefined,
            ts.TypeFormatFlags.InTypeAlias,
          );
        };

        expect(aliasText('Kept')).toBe('number');
        expect(aliasText('Folded')).toBe('2 | 4');
      } finally {
        await session.dispose();
      }
    });
  });
});
