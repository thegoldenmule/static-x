import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { introduceParameter } from './introduce-parameter.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/introduce-parameter-ts');
const src = (name: string) => path.join(FIXTURE, 'src', name);

describe('ts/refactors/introduce-parameter', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it(
    'replaces every occurrence and passes the expression at every call',
    { timeout: 30_000 },
    async () => {
      const before = await readFile(src('logger.ts'), 'utf8');
      const result = await introduceParameter.run(session, {
        file: 'src/logger.ts',
        select: "'info'",
        name: 'level',
      });

      expect(result.applied).toBe(false);
      expect(result.newDiagnostics).toEqual([]);
      // Both occurrences, not just the one the selection sat on.
      expect(result.occurrences).toBe(2);
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
      expect(logger).toContain('export function log(message: string, level: string): string {');
      expect(logger).toContain('  const tag = level.toUpperCase();');
      expect(logger).toContain(
        '  return message.startsWith(level) ? message : `[${tag}] ${message}`;',
      );
      expect(logger).not.toContain("'info'");

      for (const file of ['alpha.ts', 'beta.ts', 'gamma.ts']) {
        const caller = await preview(result.edit, src(file));
        expect(caller).toContain(`log('${file.replace('.ts', '')} started', 'info')`);
      }

      // An exported function with a required parameter is a source break
      // nothing inside the project can observe.
      expect(result.warnings).toEqual([
        '"log" is exported and "level" is required, so callers outside this project must be ' +
          'updated; the typecheck only sees the 3 call sites in it',
      ]);
      expect(await readFile(src('logger.ts'), 'utf8')).toBe(before); // dry-run
    },
  );

  it('keeps a multi-line list multi-line, at the index asked for', { timeout: 30_000 }, async () => {
    const result = await introduceParameter.run(session, {
      file: 'src/layout.ts',
      select: "'https'",
      name: 'scheme',
      position: 0,
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.occurrences).toBe(1);

    const layout = await preview(result.edit, src('layout.ts'));
    expect(layout).toContain(
      'export function connect(\n  scheme: string,\n  host: string,\n  port: number,\n): string {',
    );
    expect(layout).toContain('  return [scheme, host, port].join(\':\');');
    // A one-line call gains a one-line argument; a broken-out one keeps
    // its own shape and its trailing comma.
    expect(layout).toContain("return connect('https', 'localhost', 8080);");
    expect(layout).toContain(
      "return connect(\n    'https',\n    'example.com',\n    9090,\n  );",
    );
  });

  it('places the argument by the resolved signature, where `this` has no slot', { timeout: 30_000 }, async () => {
    const result = await introduceParameter.run(session, {
      file: 'src/context.ts',
      select: "'boot'",
      name: 'stage',
      position: 0,
    });

    expect(result.newDiagnostics).toEqual([]);
    const context = await preview(result.edit, src('context.ts'));
    // Value-parameter index 0 is declaration index 1: `this` keeps its
    // place, and the argument lands at argument index 0.
    expect(context).toContain('run(this: Ctx, stage: string, message: string): string {');
    expect(context).toContain("    return [this.name, stage, message].join(' ');");
    expect(context).toContain("return [ctx.run('boot', 'one'), ctx.run('boot', 'two')];");
  });

  it('puts the parameter on the enclosing named function, not the callback', { timeout: 30_000 }, async () => {
    const result = await introduceParameter.run(session, {
      file: 'src/nested.ts',
      select: '10',
      name: 'factor',
    });

    expect(result.newDiagnostics).toEqual([]);
    const nested = await preview(result.edit, src('nested.ts'));
    expect(nested).toContain('export function scaleAll(values: number[], factor: number): number[] {');
    // The arrow closes over the new parameter.
    expect(nested).toContain('  return values.map((value) => value * factor);');
    expect(nested).toContain('return scaleAll([1, 2], 10);');
  });

  it('leaves every call alone when the parameter has a default', { timeout: 30_000 }, async () => {
    const result = await introduceParameter.run(session, {
      file: 'src/defaults.ts',
      select: "'Hello'",
      name: 'greeting',
      defaultValue: "'Hello'",
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.occurrences).toBe(1);
    // The blast radius is still reported, even though nothing is written there.
    expect(result.callSites).toHaveLength(1);
    expect(result.callSites[0]?.file).toBe(src('defaults.ts'));

    const defaults = await preview(result.edit, src('defaults.ts'));
    expect(defaults).toContain(
      "export function greet(name: string, greeting: string = 'Hello'): string {",
    );
    expect(defaults).toContain('  return [greeting, name].join(\', \');');
    expect(defaults).toContain("return greet('Ada');");
    // Optional, so no source break to warn about.
    expect(result.warnings).toEqual([]);
  });

  it('refuses a defaulted parameter that would capture an existing argument', { timeout: 30_000 }, async () => {
    // Nothing is written at the call, so `'Ada'` would start feeding
    // `greeting` — two `string`s, so the typecheck stays green.
    await expect(
      introduceParameter.run(session, {
        file: 'src/defaults.ts',
        select: "'Hello'",
        name: 'greeting',
        defaultValue: "'Hello'",
        position: 0,
      }),
    ).rejects.toThrow(
      /already passes an argument at slot 0[\s\S]*would silently become "greeting"/,
    );
  });

  it('warns when the default is not the expression it replaced', { timeout: 30_000 }, async () => {
    const result = await introduceParameter.run(session, {
      file: 'src/defaults.ts',
      select: "'Hello'",
      name: 'greeting',
      defaultValue: "'Hi'",
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('defaults.ts'))).toContain(
      "export function greet(name: string, greeting: string = 'Hi'): string {",
    );
    expect(result.warnings).toEqual([
      'Existing callers pass nothing, so "greet" now evaluates \'Hi\' where its body evaluated ' +
        "'Hello'; confirm the two agree",
    ]);
  });

  it('warns when a single impure expression moves to the call site', { timeout: 30_000 }, async () => {
    const result = await introduceParameter.run(session, {
      file: 'src/effects.ts',
      select: 'bump()',
      within: 'once',
      name: 'tick',
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.occurrences).toBe(1);
    const effects = await preview(result.edit, src('effects.ts'));
    expect(effects).toContain('export function once(label: string, tick: number): string {');
    expect(effects).toContain('  return `${label}#${tick}`;');
    expect(effects).toContain("return `${twice()} ${once('a', bump())}`;");
    expect(result.warnings).toContain(
      'bump() could do something observable; it now runs at each call site, before "once" is ' +
        'entered, rather than where it sat in the body',
    );
  });

  it('refuses an impure expression that occurs more than once', { timeout: 30_000 }, async () => {
    await expect(
      introduceParameter.run(session, {
        file: 'src/effects.ts',
        select: 'bump()',
        within: 'twice',
        name: 'tick',
      }),
    ).rejects.toThrow(/bump\(\) could do something observable and occurs 2 times in "twice"/);
  });

  it('refuses an expression built from the function\'s own bindings', { timeout: 30_000 }, async () => {
    await expect(
      introduceParameter.run(session, {
        file: 'src/capture.ts',
        select: 'value * 2',
        name: 'doubled',
      }),
    ).rejects.toThrow(
      /value \* 2 depends on "value", which "scaled" declares \(.*capture\.ts:1:/,
    );
  });

  it('refuses a name that means something else at a call site', { timeout: 30_000 }, async () => {
    await expect(
      introduceParameter.run(session, {
        file: 'src/shadow.ts',
        select: 'SCALE',
        within: 'boost',
        name: 'factor',
      }),
    ).rejects.toThrow(
      /SCALE cannot be evaluated at .*shadow\.ts:9:.*"SCALE" means something different there/,
    );
  });

  it('refuses a parameter name the body already uses', { timeout: 30_000 }, async () => {
    await expect(
      introduceParameter.run(session, {
        file: 'src/collide.ts',
        select: '2',
        name: 'width',
      }),
    ).rejects.toThrow(/"width" already means something inside "pad"/);
  });

  it('refuses when the body assigns to the expression', { timeout: 30_000 }, async () => {
    await expect(
      introduceParameter.run(session, {
        file: 'src/writes.ts',
        select: 'counts.total',
        name: 'total',
      }),
    ).rejects.toThrow(/The body of "tally" assigns to counts\.total at .*writes\.ts:4:/);
  });

  it('refuses an expression bound to the function itself', { timeout: 30_000 }, async () => {
    await expect(
      introduceParameter.run(session, {
        file: 'src/context.ts',
        select: 'this.name',
        name: 'label',
      }),
    ).rejects.toThrow(/this\.name reads `this`, which is bound to "run" itself/);
  });

  it('refuses a callee handed out as a value', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const escape = path.join(root, 'src/escape.ts');
      const before = await readFile(escape, 'utf8');

      const failure = await introduceParameter
        .run(copy, { file: 'src/escape.ts', select: "'#'", name: 'marker', apply: true })
        .then(() => undefined)
        .catch((error: unknown) => (error as Error).message);

      expect(failure).toMatch(/"tag" is not only called/);
      expect(failure).toContain(`${escape}:11:`); // lines.map(tag)
      expect(await readFile(escape, 'utf8')).toBe(before);
    });
  });

  it('refuses the shapes it cannot reason about', { timeout: 30_000 }, async () => {
    await expect(
      introduceParameter.run(session, { file: 'src/spread.ts', select: "'-'", name: 'sep' }),
    ).rejects.toThrow(/called with spread arguments[\s\S]*spread\.ts:8:10 \(spread-call\)/);

    await expect(
      introduceParameter.run(session, { file: 'src/overloads.ts', select: '8', name: 'pad' }),
    ).rejects.toThrow(/"widen" is an overload set \(3 declarations\)/);

    await expect(
      introduceParameter.run(session, { file: 'src/hierarchy.ts', select: "'> '", name: 'prefix' }),
    ).rejects.toThrow(/"render" shares its signature[\s\S]*Derived at .*hierarchy\.ts:13/);

    await expect(
      introduceParameter.run(session, {
        file: 'src/recursion.ts',
        select: '100',
        name: 'step',
      }),
    ).rejects.toThrow(/"countdown" calls itself at .*recursion\.ts:2:/);

    await expect(
      introduceParameter.run(session, { file: 'src/omitted.ts', select: "'['", name: 'open' }),
    ).rejects.toThrow(
      /passes 1 argument and omits the optional ones before "open"'s slot \(2\)/,
    );
  });

  it('refuses a selection with no signature to change', { timeout: 30_000 }, async () => {
    await expect(
      introduceParameter.run(session, { file: 'src/anon.ts', select: '7', name: 'factor' }),
    ).rejects.toThrow(/not inside the body of a named function in src\/anon\.ts \(found at lines 3\)/);

    await expect(
      introduceParameter.run(session, { file: 'src/anon.ts', select: '4 * 2', name: 'wide' }),
    ).rejects.toThrow(/not inside the body of a named function in src\/anon\.ts \(found at lines 7\)/);
  });

  it('refuses a type it cannot name where the parameter goes', { timeout: 30_000 }, async () => {
    await expect(
      introduceParameter.run(session, {
        file: 'src/unnameable.ts',
        select: 'MARKER',
        name: 'marker',
      }),
    ).rejects.toThrow(
      /The type of MARKER cannot be named in src\/unnameable\.ts \(the checker prints it as import\(/,
    );
  });

  it('reports bad addressing rather than guessing', { timeout: 30_000 }, async () => {
    await expect(
      introduceParameter.run(session, { file: 'src/logger.ts', select: "'info'", name: '2bad' }),
    ).rejects.toThrow(/"2bad" is not a valid identifier/);

    await expect(
      introduceParameter.run(session, {
        file: 'src/logger.ts',
        select: "'info'",
        name: 'level',
        position: 5,
      }),
    ).rejects.toThrow(/position 5 is outside "log"'s 1 value parameters/);

    // Two functions in effects.ts hold `bump()`, so it needs `within`.
    await expect(
      introduceParameter.run(session, { file: 'src/effects.ts', select: 'bump()', name: 'tick' }),
    ).rejects.toThrow(/occurs in 2 functions in src\/effects\.ts \(twice at line 9, once at line 13\)/);

    // Not an expression: locateSelection is what says so.
    await expect(
      introduceParameter.run(session, {
        file: 'src/logger.ts',
        select: "const tag = 'info'.toUpperCase();",
        name: 'level',
      }),
    ).rejects.toThrow(/That selection is a statement run at src\/logger\.ts:9/);

    // A name in a name position is not a value a caller could pass.
    await expect(
      introduceParameter.run(session, {
        file: 'src/logger.ts',
        select: 'toUpperCase',
        name: 'method',
      }),
    ).rejects.toThrow(/occurs at src\/logger\.ts:9 only where it names something/);

    await expect(
      introduceParameter.run(session, { file: 'src/logger.ts', select: 'nowhere', name: 'level' }),
    ).rejects.toThrow(/not a whole statement, run of statements, expression, or type/);
  });

  it('refuses an edit the typecheck rejects, even with apply', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const report = path.join(root, 'src/report.ts');
      const before = await readFile(report, 'utf8');

      // Appending a required parameter after an optional one is TS1016.
      // The arity rule belongs to the compiler, not to this tool.
      const result = await introduceParameter.run(copy, {
        file: 'src/report.ts',
        select: "'!'",
        name: 'mark',
        apply: true,
      });

      expect(result.applied).toBe(false);
      expect(result.newDiagnostics.join('\n')).toMatch(/TS1016/);
      expect(await readFile(report, 'utf8')).toBe(before);
    });
  });
});

describe('ts/refactors/introduce-parameter apply mode', () => {
  it('writes the signature, the body, and every call site', { timeout: 30_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const result = await introduceParameter.run(copy, {
        file: 'src/logger.ts',
        select: "'info'",
        name: 'level',
        apply: true,
      });

      expect(result.applied).toBe(true);
      expect(result.newDiagnostics).toEqual([]);

      const logger = await readFile(path.join(root, 'src/logger.ts'), 'utf8');
      expect(logger).toContain('export function log(message: string, level: string): string {');
      expect(logger).not.toContain("'info'");
      expect(await readFile(path.join(root, 'src/alpha.ts'), 'utf8')).toContain(
        "log('alpha started', 'info')",
      );
      expect(await readFile(path.join(root, 'src/gamma.ts'), 'utf8')).toContain(
        "log('gamma started', 'info')",
      );

      // Reopened from disk: the written project typechecks clean.
      const reopened = TsProjectSession.open(root);
      try {
        const program = reopened.program();
        const errors = program
          .getSourceFiles()
          .filter((file) => file.fileName.startsWith(root))
          .flatMap((file) => program.getSemanticDiagnostics(file));
        expect(errors.map((error) => error.messageText)).toEqual([]);
      } finally {
        await reopened.dispose();
      }

      // The session saw the write, so the expression is gone from the body.
      await expect(
        introduceParameter.run(copy, {
          file: 'src/logger.ts',
          select: "'info'",
          name: 'severity',
        }),
      ).rejects.toThrow(/not a whole statement, run of statements, expression, or type/);
    });
  });
});
