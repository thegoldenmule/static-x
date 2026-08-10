import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { changeSignature } from './change-signature.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/change-signature-ts');
const file = (name: string) => path.join(FIXTURE, 'src', name);

const session = TsProjectSession.open(FIXTURE);
afterAll(() => session.dispose());

describe('ts/refactors/change-signature', () => {
  it('converts a signature and every call, across files', { timeout: 30_000 }, async () => {
    const result = await changeSignature.run(session, { symbol: 'greet' });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics).toEqual([]);

    expect(await preview(result.edit, file('options.ts'))).toContain(
      '{ name, loud }: { name: string; loud: boolean; }',
    );
    expect(await preview(result.edit, file('consumer-a.ts'))).toContain(
      "greet({ name: 'world', loud: false })",
    );
    expect(await readFile(file('options.ts'), 'utf8')).toContain('greet(name: string, loud: boolean)');
  });

  it('reaches a namespace-qualified call in another file', { timeout: 30_000 }, async () => {
    const result = await changeSignature.run(session, { symbol: 'makeOptions' });

    expect(result.newDiagnostics).toEqual([]);
    // `everything.makeOptions(...)` is the call an LLM editing options.ts
    // would never see, and it is rewritten with the rest.
    expect(await preview(result.edit, file('consumer-b.ts'))).toContain(
      "everything.makeOptions({ host: 'beta', port: 2, secure: false })",
    );
    expect(result.callSites.map((site) => path.basename(site.file)).sort()).toEqual([
      'consumer-a.ts',
      'consumer-b.ts',
    ]);
  });

  it('rewrites a call TypeScript drops, rather than refusing over its bug', { timeout: 30_000 }, async () => {
    // twin-one.ts and twin-two.ts are byte-identical, so their calls sit
    // at the same offset. TypeScript deduplicates call sites by position
    // without comparing files, rewrites one, drops the other, and
    // reports nothing — leaving that caller calling positionally.
    const result = await changeSignature.run(session, { symbol: 'twinned' });

    expect(result.newDiagnostics).toEqual([]);
    for (const twin of ['twin-one.ts', 'twin-two.ts']) {
      expect(await preview(result.edit, file(twin)), twin).toContain(
        "twinned({ a: 'same', b: 9, c: true })",
      );
    }
    // The repair is reported: the caller learns the engine skipped a
    // call, rather than the tool quietly covering for it.
    expect(result.warnings.join('\n')).toMatch(/skipped the call.*twin-two\.ts/s);
  });

  it('refuses when the function is handed out as a value', { timeout: 30_000 }, async () => {
    // TypeScript reports this applicable and then returns no edits at
    // all — silence indistinguishable from success. The classifier has
    // to refuse before the engine is asked.
    await expect(changeSignature.run(session, { symbol: 'escaped' })).rejects.toThrow(
      /not only called.*uses-value\.ts/s,
    );
  });

  it('refuses a spread call, where argument positions are a runtime fact', { timeout: 30_000 }, async () => {
    await expect(changeSignature.run(session, { symbol: 'spreadTarget' })).rejects.toThrow(
      /spread arguments/,
    );
  });

  it('refuses targets it cannot convert', { timeout: 30_000 }, async () => {
    await expect(changeSignature.run(session, { symbol: 'nothingHere' })).rejects.toThrow(
      /No declaration named/,
    );
  });

  it('applies a repaired conversion, leaving the project compiling', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await changeSignature.run(copy, { symbol: 'twinned', apply: true });
      expect(result.applied).toBe(true);

      for (const twin of ['twin-one.ts', 'twin-two.ts']) {
        expect(await readFile(path.join(root, 'src', twin), 'utf8'), twin).toContain(
          "twinned({ a: 'same', b: 9, c: true })",
        );
      }

      // The repair has to survive a real compile, not just the guard:
      // an authored edit that merely looked right would fail here.
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

  it('applies the conversion, leaving the project compiling', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await changeSignature.run(copy, { symbol: 'greet', apply: true });

      expect(result.applied).toBe(true);
      expect(await readFile(path.join(root, 'src/options.ts'), 'utf8')).toContain('{ name, loud }');
      expect(await readFile(path.join(root, 'src/consumer-a.ts'), 'utf8')).toContain(
        "greet({ name: 'world', loud: false })",
      );

      // The real proof: reopening the written project produces no errors.
      const reopened = TsProjectSession.open(root);
      try {
        const errors = reopened
          .program()
          .getSemanticDiagnostics()
          .filter((diagnostic) => diagnostic.file);
        expect(errors.map((diagnostic) => diagnostic.messageText)).toEqual([]);
      } finally {
        await reopened.dispose();
      }
    });
  });
});
