import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { extractType } from './extract-type.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/extract-type-ts');
const src = (file: string) => path.join(FIXTURE, 'src', file);

const session = TsProjectSession.open(FIXTURE);
afterAll(() => session.dispose());

const HOST_PORT = '{ host: string; port: number }';

describe('ts/refactors/extract-type', () => {
  it('lifts an inline type into a named alias', { timeout: 30_000 }, async () => {
    const result = await extractType.run(session, {
      file: 'src/net.ts',
      select: HOST_PORT,
      within: 'connect',
      name: 'Endpoint',
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.name).toBe('Endpoint');
    const text = await preview(result.edit, src('net.ts'));
    expect(text).toContain('type Endpoint = {');
    expect(text).toContain('export function connect(target: Endpoint): string');
    expect(text).not.toContain('NewType');
  });

  it('lifts to an interface when asked', { timeout: 30_000 }, async () => {
    const result = await extractType.run(session, {
      file: 'src/net.ts',
      select: HOST_PORT,
      within: 'connect',
      form: 'interface',
      name: 'Endpoint',
    });

    expect(result.forms).toEqual(['alias', 'interface']);
    expect(await preview(result.edit, src('net.ts'))).toContain('interface Endpoint {');
  });

  it('propagates a captured type parameter', { timeout: 30_000 }, async () => {
    const result = await extractType.run(session, {
      file: 'src/net.ts',
      select: '{ value: T; tag: string }',
      name: 'Boxed',
    });

    expect(result.newDiagnostics).toEqual([]);
    const text = await preview(result.edit, src('net.ts'));
    // The shape mentions T, so the alias has to be generic and the use
    // site has to pass it — the work that makes this semantic.
    expect(text).toContain('type Boxed<T> = {');
    expect(text).toContain('box: Boxed<T>');
  });

  it('offers only an alias for a function type', { timeout: 30_000 }, async () => {
    const result = await extractType.run(session, {
      file: 'src/net.ts',
      select: '(event: { kind: string; at: number }) => void',
      name: 'Handler',
    });

    expect(result.forms).toEqual(['alias']);
    await expect(
      extractType.run(session, {
        file: 'src/net.ts',
        select: '(event: { kind: string; at: number }) => void',
        form: 'interface',
      }),
    ).rejects.toThrow(/will not extract that type to an interface/);
  });

  it('reports identical shapes elsewhere without touching them', { timeout: 30_000 }, async () => {
    const result = await extractType.run(session, {
      file: 'src/net.ts',
      select: HOST_PORT,
      within: 'connect',
      name: 'Endpoint',
    });

    // listen() in the same file, ping() in another — found by tokens,
    // which is knowledge of the project no single file contains.
    const at = result.duplicates.map((d) => `${path.basename(d.file)}:${d.line + 1}`);
    expect(at).toContain(`net.ts:${6}`);
    expect(at.some((where) => where.startsWith('other.ts:'))).toBe(true);
    // A different shape must not be swept in: shapeKey would conflate
    // these, which is why identity is tokenKey.
    expect(result.duplicates.map((d) => d.text)).not.toContain('{ name: string; rank: number }');
    // Reported, not replaced.
    expect(await preview(result.edit, src('net.ts'))).toContain('on: { host: string; port: number }');
  });

  it('replaces identical shapes in the same file with dedupe', { timeout: 30_000 }, async () => {
    const result = await extractType.run(session, {
      file: 'src/net.ts',
      select: HOST_PORT,
      within: 'connect',
      name: 'Endpoint',
      dedupe: true,
    });

    expect(result.newDiagnostics).toEqual([]);
    const text = await preview(result.edit, src('net.ts'));
    expect(text).toContain('export function listen(on: Endpoint): void');
    expect(text).toContain('export function connect(target: Endpoint): string');
    // The unrelated shape is untouched.
    expect(text).toContain('of: { name: string; rank: number }');
    // The one in another file cannot name a non-exported alias, so it
    // is left alone and said so rather than being broken.
    expect(await preview(result.edit, src('other.ts'))).toContain(HOST_PORT);
    expect(result.warnings.join('\n')).toContain('another file was left alone');
  });

  it('refuses a selection that is not a type', { timeout: 30_000 }, async () => {
    await expect(
      extractType.run(session, { file: 'src/net.ts', select: 'return box.value;' }),
    ).rejects.toThrow(/not a type/);
  });

  it('writes the extraction to disk, leaving the project compiling', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await extractType.run(copy, {
        file: 'src/net.ts',
        select: HOST_PORT,
        within: 'connect',
        name: 'Endpoint',
        dedupe: true,
        apply: true,
      });

      expect(result.applied).toBe(true);
      const text = await readFile(path.join(root, 'src/net.ts'), 'utf8');
      expect(text).toContain('type Endpoint = {');
      expect(text).toContain('connect(target: Endpoint)');
      expect(text).toContain('listen(on: Endpoint)');

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
