import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { inlineTypeAlias } from './inline-type-alias.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/inline-type-alias-ts');
const src = (file: string) => path.join(FIXTURE, 'src', file);

const session = TsProjectSession.open(FIXTURE);
afterAll(() => session.dispose());

describe('ts/refactors/inline-type-alias', () => {
  it('parenthesizes a union substituted into an array type', { timeout: 30_000 }, async () => {
    // The silent failure: `type Ids = Id[]` written as
    // `string | number[]` compiles, and firstId() starts accepting a
    // bare string. Measured on a scratch project — tsc exits 0 on it —
    // so the guard is structurally unable to be what catches this.
    const result = await inlineTypeAlias.run(session, { symbol: 'Id' });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.definition).toBe('string | number');
    const consumer = await preview(result.edit, src('consumer.ts'));
    expect(consumer).toContain('export type Ids = (string | number)[];');
    expect(consumer).toContain("export const ids: (string | number)[] = [1, 'two'];");
  });

  it('leaves a delimited position alone', { timeout: 30_000 }, async () => {
    // A type argument is already bracketed and comma-separated, so the
    // factory has no parenthesizer rule for it and neither does this.
    const result = await inlineTypeAlias.run(session, { symbol: 'Id' });

    const consumer = await preview(result.edit, src('consumer.ts'));
    expect(consumer).toContain('export type Lookup = Record<string, string | number>;');
    expect(consumer).toContain('export function label(id: string | number, tag: Tag): string');
  });

  it('wraps a union inside a union, as the compiler would', { timeout: 30_000 }, async () => {
    // `(string | number) | undefined` is one pair more than a person
    // would write and exactly what createUnionTypeNode produces. Taking
    // the compiler's answer everywhere is what keeps this rule from
    // drifting away from the one the compiler enforces.
    const result = await inlineTypeAlias.run(session, { symbol: 'Id' });

    expect(await preview(result.edit, src('consumer.ts'))).toContain(
      'export type Maybe = (string | number) | undefined;',
    );
  });

  it('deletes the declaration, its documentation, and its import', { timeout: 30_000 }, async () => {
    const result = await inlineTypeAlias.run(session, { symbol: 'Datagram' });

    const types = await preview(result.edit, src('types.ts'));
    expect(types).not.toContain('export type Datagram');
    expect(types).not.toContain('nothing to parenthesize');
    expect(types).toContain('export interface Packet');
    // Losing the prose is worth saying, since it does not travel.
    expect(result.warnings.join('\n')).toMatch(/documentation on "Datagram" is deleted/);
  });

  it('unbinds only the alias, leaving the rest of the import', { timeout: 30_000 }, async () => {
    // net.ts imports `Datagram` and `Packet` from the same statement,
    // and the right-hand side is `Packet` — so the specifier goes and
    // the statement stays.
    const result = await inlineTypeAlias.run(session, { symbol: 'Datagram' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('net.ts'))).toBe(
      "import type { Packet } from './types.js';\n" +
        '\n' +
        'export interface Stamped extends Packet {\n' +
        '  checksum: string;\n' +
        '}\n' +
        '\n' +
        'export function sizeOf(datagram: Packet): number {\n' +
        '  return datagram.bytes;\n' +
        '}\n' +
        '\n' +
        'export function wrap(packet: Packet): Packet {\n' +
        '  return packet;\n' +
        '}\n',
    );
  });

  it('finds the right-hand side through a type-only import', { timeout: 30_000 }, async () => {
    // `import type { Packet }` binds a symbol whose own flags are Alias,
    // not Type. Asking getSymbolsInScope for Type omits it — 1761 names
    // at that site, none of them Packet — and every use of Datagram
    // would be refused as out of scope. SymbolFlags.All finds 2140 and
    // does include it, which is why this inlines at all.
    const result = await inlineTypeAlias.run(session, { symbol: 'Datagram' });

    expect(result.useSites).toHaveLength(3);
    expect(result.newDiagnostics).toEqual([]);
  });

  it('substitutes a type reference into an extends clause', { timeout: 30_000 }, async () => {
    const result = await inlineTypeAlias.run(session, { symbol: 'Datagram' });

    expect(await preview(result.edit, src('net.ts'))).toContain(
      'export interface Stamped extends Packet {',
    );
  });

  it('rewrites a namespace-qualified reference whole', { timeout: 30_000 }, async () => {
    // `types.Id` is a QualifiedName inside the type reference; replacing
    // just the `Id` identifier would leave `types.` behind.
    const result = await inlineTypeAlias.run(session, { symbol: 'Id' });

    expect(await preview(result.edit, src('namespaced.ts'))).toContain(
      'export const empty: string | number = types.EMPTY_ID;',
    );
  });

  it('removes a barrel re-export of the alias', { timeout: 30_000 }, async () => {
    // Nothing in barrel.ts changed, so nothing draws attention to it —
    // but `export type { Id } from './types.js'` after the declaration
    // is gone is TS2305, and the guard would refuse the whole inline.
    const result = await inlineTypeAlias.run(session, { symbol: 'Id' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('barrel.ts'))).toBe(
      "export type { Tag } from './types.js';\nexport { label } from './consumer.js';\n",
    );
    expect(result.warnings.join('\n')).toMatch(/public surface/);
  });

  it('keeps a statement sharing the declaration line', { timeout: 30_000 }, async () => {
    // The declaration usually owns its lines and they go with it. Here
    // `export const SLUG_MAX = 64;` sits on the same one, and taking
    // the line would delete a value nobody asked about.
    const result = await inlineTypeAlias.run(session, { symbol: 'Slug' });

    expect(result.newDiagnostics).toEqual([]);
    const types = await preview(result.edit, src('types.ts'));
    expect(types).not.toContain('export type Slug');
    expect(types).toContain('export const SLUG_MAX = 64;');
    expect(await preview(result.edit, src('consumer.ts'))).toContain(
      'export function trimSlug(value: string): string {',
    );
  });

  it('refuses a generic alias', { timeout: 30_000 }, async () => {
    await expect(inlineTypeAlias.run(session, { symbol: 'Box' })).rejects.toThrow(
      /is generic \(<T>\).*positionally/s,
    );
  });

  it('refuses when the right-hand side names something the use site cannot see', { timeout: 30_000 }, async () => {
    // Reading is `{ source: Sensor; value: number }` and types.ts does
    // not export Sensor. The guard would catch this one as TS2304; the
    // message is better than the diagnostic.
    await expect(inlineTypeAlias.run(session, { symbol: 'Reading' })).rejects.toThrow(
      /"Sensor" is not in scope there/,
    );
  });

  it('refuses when a name in the right-hand side means something else there', { timeout: 30_000 }, async () => {
    // shadow.ts declares its own `Frame`, structurally compatible with
    // the one Envelope refers to. Substituting rebinds it and the
    // project still compiles clean — measured, not assumed — so this
    // refusal has to happen before the edit exists, not after.
    await expect(inlineTypeAlias.run(session, { symbol: 'Envelope' })).rejects.toThrow(
      /"Frame" means something different there/,
    );
  });

  it('refuses a use inside a declare block', { timeout: 30_000 }, async () => {
    await expect(inlineTypeAlias.run(session, { symbol: 'Millis' })).rejects.toThrow(
      /inside a `declare global` block/,
    );
  });

  it('refuses an extends clause the right-hand side cannot fill', { timeout: 30_000 }, async () => {
    // `interface Person extends { name: string }` is not syntax. A
    // heritage clause holds a name, and `Named`'s right-hand side is a
    // type literal.
    await expect(inlineTypeAlias.run(session, { symbol: 'Named' })).rejects.toThrow(
      /extends\/implements clause.*is not one/s,
    );
  });

  it('refuses a self-referential alias', { timeout: 30_000 }, async () => {
    await expect(inlineTypeAlias.run(session, { symbol: 'Tree' })).rejects.toThrow(
      /refers to itself/,
    );
  });

  it('refuses an alias nothing refers to', { timeout: 30_000 }, async () => {
    await expect(inlineTypeAlias.run(session, { symbol: 'Unused' })).rejects.toThrow(
      /Nothing refers to "Unused".*safe-delete/s,
    );
  });

  it('refuses an interface', { timeout: 30_000 }, async () => {
    await expect(inlineTypeAlias.run(session, { symbol: 'Packet' })).rejects.toThrow(
      /is an interface, not a type alias/,
    );
  });

  it('writes the inline to disk, leaving the project compiling', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await inlineTypeAlias.run(copy, { symbol: 'Id', apply: true });

      expect(result.applied).toBe(true);
      expect(result.useSites.map((site) => path.basename(site.file)).sort()).toEqual([
        'consumer.ts',
        'consumer.ts',
        'consumer.ts',
        'consumer.ts',
        'consumer.ts',
        'consumer.ts',
        'namespaced.ts',
        'types.ts',
      ]);
      expect(await readFile(path.join(root, 'src/consumer.ts'), 'utf8')).toContain(
        'export type Ids = (string | number)[];',
      );
      expect(await readFile(path.join(root, 'src/types.ts'), 'utf8')).not.toContain(
        'export type Id =',
      );

      // A substitution that merely looked right — a dropped import, a
      // stale barrel, a union that lost its parentheses — fails here.
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
