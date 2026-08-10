import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { inlineParameter } from './inline-parameter.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/inline-parameter-ts');
const src = (name: string) => path.join(FIXTURE, 'src', name);

describe('ts/refactors/inline-parameter', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it(
    'drops a parameter three callers agree on, binding it in the body',
    { timeout: 30_000 },
    async () => {
      const before = await readFile(src('logger.ts'), 'utf8');
      const result = await inlineParameter.run(session, {
        symbol: 'log',
        parameter: 'level',
      });

      expect(result.applied).toBe(false);
      expect(result.newDiagnostics).toEqual([]);
      expect(result.value).toBe("'info'");
      expect(result.filesChanged).toEqual([
        src('alpha.ts'),
        src('beta.ts'),
        src('gamma.ts'),
        src('logger.ts'),
      ]);
      expect(result.callSites.map((site) => site.file).sort()).toEqual([
        src('alpha.ts'),
        src('beta.ts'),
        src('gamma.ts'),
      ]);

      const logger = await preview(result.edit, src('logger.ts'));
      expect(logger).toContain('export function log(message: string): string {');
      expect(logger).toContain(
        "  /** Severity label printed alongside the message. */\n  const level: string = 'info';",
      );
      // The binding lands ahead of the body, not appended to it.
      expect(logger.indexOf('const level')).toBeLessThan(logger.indexOf('return `['));
      // The @param line moved with the parameter, or stale-refs would
      // flag the result immediately.
      expect(logger).not.toContain('@param level');
      expect(logger).toContain('@param message The text to write.');

      for (const file of ['alpha.ts', 'beta.ts', 'gamma.ts']) {
        const caller = await preview(result.edit, src(file));
        expect(caller).toContain(`log('${file.replace('.ts', '')} started')`);
        expect(caller).not.toContain("'info'");
      }

      expect(await readFile(src('logger.ts'), 'utf8')).toBe(before); // dry-run
    },
  );

  it(
    'maps arguments through the resolved signature, not by counting commas',
    { timeout: 30_000 },
    async () => {
      const result = await inlineParameter.run(session, {
        symbol: 'format',
        file: src('defaults.ts'),
        parameter: 'b',
      });

      expect(result.newDiagnostics).toEqual([]);
      // The caller that omits `b` reads the parameter's default.
      expect(result.value).toBe('5');

      const defaults = await preview(result.edit, src('defaults.ts'));
      expect(defaults).toContain('export function format(a: string, c?: number): string {');
      expect(defaults).toContain('  const b = 5;');
      // `f('x')` never named `b`, so it is untouched...
      expect(defaults).toContain("return format('x');");
      // ...while `f('x', 5, 9)` loses the middle argument and keeps the
      // trailing one. A positional implementation drops `9` instead.
      expect(defaults).toContain("return format('x', 9);");
      expect(defaults).not.toContain("format('x', 5)");
    },
  );

  it(
    'reads the argument index from the signature, where `this` has no slot',
    { timeout: 30_000 },
    async () => {
      const result = await inlineParameter.run(session, {
        symbol: 'run',
        parameter: 'stage',
      });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.value).toBe("'boot'");

      const context = await preview(result.edit, src('context.ts'));
      expect(context).toContain('run(this: Ctx, message: string): string {');
      expect(context).toContain("    const stage: string = 'boot';");
      // `stage` is declaration index 1 but argument index 0: indexing the
      // declaration's parameter list would delete 'one' and 'two'.
      expect(context).toContain("return [ctx.run('one'), ctx.run('two')];");
    },
  );

  it(
    'addresses the parameter by index over the value parameters only',
    { timeout: 30_000 },
    async () => {
      const result = await inlineParameter.run(session, { symbol: 'run', parameter: 0 });
      expect(result.value).toBe("'boot'");
      expect(await preview(result.edit, src('context.ts'))).toContain(
        'run(this: Ctx, message: string): string {',
      );
    },
  );

  it('refuses when the callee is handed out as a value', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const tags = path.join(root, 'src/tags.ts');
      const before = await readFile(tags, 'utf8');

      await expect(
        inlineParameter.run(copy, { symbol: 'tag', parameter: 'index', apply: true }),
      ).rejects.toThrow(/escape/);
      // The refusal names where the escape is, not just that there is one.
      await expect(
        inlineParameter.run(copy, { symbol: 'tag', parameter: 'index', apply: true }),
      ).rejects.toThrow(new RegExp(`${tags.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:17:`));

      expect(await readFile(tags, 'utf8')).toBe(before);
    });
  });

  it('refuses when one caller passes a different value', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const divergent = path.join(root, 'src/divergent.ts');
      const before = await readFile(divergent, 'utf8');

      const failure = await inlineParameter
        .run(copy, { symbol: 'retry', parameter: 'attempts', apply: true })
        .then(() => undefined)
        .catch((error: unknown) => (error as Error).message);

      expect(failure).toMatch(/Call sites disagree about "attempts"/);
      expect(failure).toContain(`${divergent}:6:`); // retry('sync', 3)
      expect(failure).toContain(`${divergent}:10:`); // retry('index', 5)
      expect(failure).toMatch(/passes 5/);

      expect(await readFile(divergent, 'utf8')).toBe(before);
    });
  });

  it('refuses a method that shares its signature with an override', { timeout: 30_000 }, async () => {
    await expect(
      inlineParameter.run(session, { symbol: 'render', parameter: 'prefix' }),
    ).rejects.toThrow(/"render" shares its signature[\s\S]*Derived at .*hierarchy\.ts:14/);
  });

  it('refuses a value the callee cannot resolve to the same symbol', { timeout: 30_000 }, async () => {
    await expect(
      inlineParameter.run(session, { symbol: 'scale', parameter: 'factor' }),
    ).rejects.toThrow(/"FACTOR" in FACTOR names something "scale" cannot see/);
  });

  it(
    'keeps a multi-line list and its trailing commas intact',
    { timeout: 30_000 },
    async () => {
      const result = await inlineParameter.run(session, {
        symbol: 'connect',
        parameter: 'secure',
      });

      expect(result.newDiagnostics).toEqual([]);
      const layout = await preview(result.edit, src('layout.ts'));
      // Last parameter of a trailing-comma list: the comma that joined
      // it to `port` goes, the list's own trailing comma stays.
      expect(layout).toContain(
        'export function connect(\n  host: string,\n  port: number,\n): string {\n  const secure: boolean = true;\n',
      );
      expect(layout).toContain("return connect('localhost', 8080);");
      expect(layout).toContain("return connect(\n    'example.com',\n    9090,\n  );");
    },
  );

  it('warns when the value stops being evaluated at the call', { timeout: 30_000 }, async () => {
    const result = await inlineParameter.run(session, { symbol: 'stamp', parameter: 'time' });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.value).toBe('Date.now()');
    expect(result.warnings).toEqual([
      'Date.now() is evaluated inside "stamp" now rather than at each call; confirm it has no side effects that depended on running there',
    ]);
    expect(await preview(result.edit, src('layout.ts'))).toContain(
      '  const time: number = Date.now();',
    );
  });

  it('refuses the shapes it cannot reason about', { timeout: 30_000 }, async () => {
    await expect(
      inlineParameter.run(session, { symbol: 'widen', parameter: 'pad' }),
    ).rejects.toThrow(/"widen" is an overload set \(3 declarations\)/);

    await expect(
      inlineParameter.run(session, { symbol: 'counted', parameter: 'width' }),
    ).rejects.toThrow(/reads `arguments`/);

    await expect(
      inlineParameter.run(session, { symbol: 'spread', parameter: 'b' }),
    ).rejects.toThrow(/called with spread arguments[\s\S]*refusals\.ts:28:10 \(spread-call\)/);

    await expect(
      inlineParameter.run(session, { symbol: 'concise', parameter: 'b' }),
    ).rejects.toThrow(/expression-bodied arrow/);
  });

  it('refuses an edit the typecheck rejects, even with apply', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const generic = path.join(root, 'src/generic.ts');
      const before = await readFile(generic, 'utf8');

      // Every caller passes 0, so the value analysis agrees — but
      // `fallback` is an inference site for T, and binding it in the
      // body cannot preserve that.
      const result = await inlineParameter.run(copy, {
        symbol: 'pick',
        parameter: 'fallback',
        apply: true,
      });

      expect(result.applied).toBe(false);
      expect(result.value).toBe('0');
      expect(result.newDiagnostics.join('\n')).toMatch(/TS2322/);
      expect(await readFile(generic, 'utf8')).toBe(before);
    });
  });

  it('reports unusable targets by name', { timeout: 30_000 }, async () => {
    await expect(
      inlineParameter.run(session, { symbol: 'log', parameter: 'nope' }),
    ).rejects.toThrow(/has no parameter "nope"; its parameters are: message, level/);
    await expect(
      inlineParameter.run(session, { symbol: 'Ctx', parameter: 0 }),
    ).rejects.toThrow(/not a function, method, or arrow-valued const/);
  });
});

describe('ts/refactors/inline-parameter apply mode', () => {
  it('writes the signature, the binding, and every call', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await inlineParameter.run(copy, {
        symbol: 'log',
        parameter: 'level',
        apply: true,
      });

      expect(result.applied).toBe(true);
      expect(result.newDiagnostics).toEqual([]);
      expect(result.warnings).toEqual([]);

      const logger = await readFile(path.join(root, 'src/logger.ts'), 'utf8');
      expect(logger).toContain('export function log(message: string): string {');
      expect(logger).toContain("const level: string = 'info';");
      expect(await readFile(path.join(root, 'src/alpha.ts'), 'utf8')).toContain(
        "log('alpha started')",
      );
      expect(await readFile(path.join(root, 'src/gamma.ts'), 'utf8')).toContain(
        "log('gamma started')",
      );

      // The session was invalidated, so the rewritten project is the one
      // the next call sees — and it no longer has the parameter.
      await expect(
        inlineParameter.run(copy, { symbol: 'log', parameter: 'level' }),
      ).rejects.toThrow(/has no parameter "level"/);
    });
  });
});
