import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { positionOf, preview, withProjectCopy } from '../testing.js';
import { invertBoolean } from './invert-boolean.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/invert-boolean-ts');
const SESSION_TS = path.join(FIXTURE, 'src/session.ts');
const RULES_TS = path.join(FIXTURE, 'src/rules.ts');
const GATE_TS = path.join(FIXTURE, 'src/gate.ts');
const PANEL_TS = path.join(FIXTURE, 'src/panel.ts');
const RENDER_TS = path.join(FIXTURE, 'src/render.ts');
const OPTIONS_TS = path.join(FIXTURE, 'src/options.ts');
const CALLER_TS = path.join(FIXTURE, 'src/caller.ts');
const BARREL_TS = path.join(FIXTURE, 'src/barrel.ts');

function semanticDiagnostics(session: TsProjectSession): string[] {
  return session
    .program()
    .getSemanticDiagnostics()
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
}

describe('ts/refactors/invert-boolean', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('negates a variable at every write and every read', { timeout: 60_000 }, async () => {
    const result = await invertBoolean.run(session, { symbol: 'isVisible' });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.filesChanged).toEqual([SESSION_TS]);
    expect(result.sites.map((site) => site.kind)).toEqual([
      'initializer',
      'write',
      'write',
      'read',
      'read',
      'read',
      'write',
      'read',
    ]);

    const text = await preview(result.edit, SESSION_TS);
    // The declaration's own initializer flips …
    expect(text).toContain('export let isVisible = true;');
    // … each assignment's stored value flips, as a literal, not as `!true` …
    expect(text).toContain('  isVisible = false;\n}');
    expect(text).toContain('  isVisible = true;\n}');
    // … a plain read gains a `!` …
    expect(text).toContain("return !isVisible ? 'shown' : 'hidden';");
    // … and a read already under a `!` loses it instead of gaining a second.
    expect(text).toContain('if (isVisible) {');
  });

  it('brackets only where the compiler says it must', { timeout: 60_000 }, async () => {
    const text = await preview(
      (await invertBoolean.run(session, { symbol: 'isVisible' })).edit,
      SESSION_TS,
    );

    // A read whose value is the receiver of a property access: `!` binds
    // looser than `.`, so `!isVisible.toString()` would negate the string.
    expect(text).toContain('return (!isVisible).toString();');
    // A stored value that is a binary expression needs the operand
    // bracketed, and the assignment position needs nothing around it.
    expect(text).toContain('isVisible = !(a && b);');
  });

  it('negates a predicate at its returns and at every call', { timeout: 60_000 }, async () => {
    const result = await invertBoolean.run(session, { symbol: 'isEnabled' });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.filesChanged).toEqual([GATE_TS, RULES_TS]);
    expect(result.sites.filter((site) => site.kind === 'return')).toHaveLength(2);
    expect(result.sites.filter((site) => site.kind === 'call')).toHaveLength(3);

    const rules = await preview(result.edit, RULES_TS);
    expect(rules).toContain('    return false;');
    // `===` flips to its exact complement rather than gaining a `!`.
    expect(rules).toContain('  return level !== 2;');

    const gate = await preview(result.edit, GATE_TS);
    expect(gate).toContain('  if (!isEnabled(level)) {');
    expect(gate).toContain('  return isEnabled(level);');
    // `!` binds tighter than `&&`, so no brackets are added here.
    expect(gate).toContain('  return !isEnabled(level) && level > 1 ? 2 : 1;');
  });

  it('inverts an expression-bodied arrow predicate', { timeout: 60_000 }, async () => {
    const result = await invertBoolean.run(session, { symbol: 'isTerminal' });

    expect(await preview(result.edit, RULES_TS)).toContain(
      'export const isTerminal = (level: number): boolean => level !== 0;',
    );
    expect(await preview(result.edit, GATE_TS)).toContain(
      "return !isTerminal(level) ? 'end' : 'more';",
    );
  });

  it('inverts a method and the calls on its receiver', { timeout: 60_000 }, async () => {
    const result = await invertBoolean.run(session, { symbol: 'isEmpty' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, PANEL_TS)).toContain('    return this.count !== 0;');
    expect(await preview(result.edit, RENDER_TS)).toContain(
      "return !ticket.isEmpty() ? 'none' : 'some';",
    );
  });

  it('inverts a class property across the files that touch it', { timeout: 60_000 }, async () => {
    const result = await invertBoolean.run(session, { symbol: 'expanded' });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.filesChanged).toEqual([PANEL_TS, RENDER_TS]);

    const panel = await preview(result.edit, PANEL_TS);
    expect(panel).toContain('  expanded = false;');
    expect(panel).toContain("    return !this.expanded ? 'open' : 'closed';");

    const render = await preview(result.edit, RENDER_TS);
    expect(render).toContain('  if (!panel.expanded) {');
    expect(render).toContain('  panel.expanded = true;');
    // Brackets that were only holding the `!` apart from the property
    // access go with it, so repeated inversions do not accumulate them.
    expect(render).toContain('  return panel.expanded.toString();');
  });

  it('leaves a self-toggle exactly as it was', { timeout: 60_000 }, async () => {
    // `this.expanded = !this.expanded` is its own inverse, and both the
    // write and the read inside it want the same `!`. The write claims
    // it and cancels it; the read, denied, inserts one — so the two
    // edits meet in the middle and the statement comes out unchanged.
    // Getting this wrong is either `= this.expanded` (a toggle that
    // stopped toggling) or an overlapping-edit crash.
    const result = await invertBoolean.run(session, { symbol: 'expanded' });

    expect(await preview(result.edit, PANEL_TS)).toContain(
      '    this.expanded = !this.expanded;',
    );
  });

  it('treats a contextually typed object literal as a write', { timeout: 60_000 }, async () => {
    const result = await invertBoolean.run(session, { symbol: 'docked' });

    // `{ docked: false }` is a write of the property even though the key
    // is syntactically a declaration, which is how the classifier reports it.
    expect(await preview(result.edit, PANEL_TS)).toContain('  return { docked: true };');
    expect(await preview(result.edit, RENDER_TS)).toContain('  return { docked: true };');
    expect(await preview(result.edit, RENDER_TS)).toContain(
      "return !state.docked ? 'docked' : 'floating';",
    );
    expect(result.warnings.join('\n')).toContain('TypeScript is structurally typed');
  });

  it('inverts a parameter at its reads and at every argument', { timeout: 60_000 }, async () => {
    const result = await invertBoolean.run(session, { symbol: 'verbose' });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.filesChanged).toEqual([CALLER_TS, OPTIONS_TS]);
    expect(result.sites.filter((site) => site.kind === 'argument')).toHaveLength(5);

    expect(await preview(result.edit, OPTIONS_TS)).toContain('  if (!verbose) {');

    const caller = await preview(result.edit, CALLER_TS);
    expect(caller).toContain("return report(false, 'run');");
    expect(caller).toContain("return report(flag, 'run');");
    expect(caller).toContain("`${report(!flag, 'a')}/${report(flag !== true, 'b')}`");
    expect(caller).toContain("return report(!(a && b), 'run');");
  });

  it('carries the rename through the same edit', { timeout: 60_000 }, async () => {
    const result = await invertBoolean.run(session, {
      symbol: 'isVisible',
      newName: 'isHidden',
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.filesChanged).toEqual([BARREL_TS, SESSION_TS]);

    const text = await preview(result.edit, SESSION_TS);
    expect(text).toContain('export let isHidden = true;');
    expect(text).toContain('  isHidden = false;\n}');
    expect(text).toContain("return !isHidden ? 'shown' : 'hidden';");
    expect(text).toContain('if (isHidden) {');
    // The rename rewrites identifier spans; the negation rewrites `!`s,
    // operators and keywords. The two meet in one file without colliding.
    expect(text).toContain('return (!isHidden).toString();');
  });

  it('warns that a barrel keeps the old name on the new meaning', { timeout: 60_000 }, async () => {
    const result = await invertBoolean.run(session, {
      symbol: 'isVisible',
      newName: 'isHidden',
    });

    // The language server preserves the *external* name, so the barrel
    // ends up publishing "isVisible" for a value that now means hidden.
    expect(await preview(result.edit, BARREL_TS)).toContain('isHidden as isVisible');
    expect(result.warnings.join('\n')).toContain('isHidden as isVisible');
    expect(result.warnings.join('\n')).toContain('consumers read exactly backwards');
  });

  it('always says the guard cannot see this one', { timeout: 60_000 }, async () => {
    const result = await invertBoolean.run(session, { symbol: 'isEnabled' });
    expect(result.warnings.join('\n')).toContain('A typecheck cannot see this refactoring go wrong');
    expect(result.warnings.join('\n')).toContain("part of this module's public surface");
  });

  it('passes over a typeof query rather than refusing it', { timeout: 60_000 }, async () => {
    const result = await invertBoolean.run(session, { symbol: 'isVisible' });

    // `typeof isVisible` names a type the inversion does not change, so
    // the return annotation stays put while the value in the body flips.
    // The shared classifier calls this an escape — correctly, for a
    // signature refactoring — which would otherwise refuse the whole run.
    const text = await preview(result.edit, SESSION_TS);
    expect(text).toContain('export function mirror(): typeof isVisible {');
    expect(text).toContain('  return !isVisible;');
  });

  it('refuses boolean | undefined, the dangerous case', { timeout: 60_000 }, async () => {
    await expect(invertBoolean.run(session, { symbol: 'maybeShown' })).rejects.toThrow(
      /has type `boolean \| undefined`, not exactly `boolean`[\s\S]*collapsing three cases onto two/,
    );
  });

  it('refuses a literal type, which is narrower than boolean', { timeout: 60_000 }, async () => {
    await expect(invertBoolean.run(session, { symbol: 'alwaysOn' })).rejects.toThrow(
      /has type `true`, not exactly `boolean`/,
    );
  });

  it('refuses a predicate that does not return exactly boolean', { timeout: 60_000 }, async () => {
    await expect(invertBoolean.run(session, { symbol: 'describeMaybe' })).rejects.toThrow(
      /returns `string`, not exactly `boolean`/,
    );
  });

  it('refuses a compound assignment', { timeout: 60_000 }, async () => {
    await expect(invertBoolean.run(session, { symbol: 'counted' })).rejects.toThrow(
      /is compound-assigned[\s\S]*no compound operator expresses that/,
    );
  });

  it('refuses a destructured reference', { timeout: 60_000 }, async () => {
    await expect(invertBoolean.run(session, { symbol: 'loud' })).rejects.toThrow(
      /is destructured[\s\S]*would silently keep the old sense/,
    );
  });

  it('refuses a shorthand property', { timeout: 60_000 }, async () => {
    await expect(invertBoolean.run(session, { symbol: 'bundled' })).rejects.toThrow(
      /is read as a shorthand property[\s\S]*longhand/,
    );
  });

  it('refuses an assignment whose own value is consumed', { timeout: 60_000 }, async () => {
    await expect(invertBoolean.run(session, { symbol: 'latched' })).rejects.toThrow(
      /is itself used as a value[\s\S]*invert the surrounding expression too/,
    );
  });

  it('refuses a predicate handed out as a value', { timeout: 60_000 }, async () => {
    await expect(invertBoolean.run(session, { symbol: 'positive' })).rejects.toThrow(
      /is not only called[\s\S]*would compile and misbehave/,
    );
  });

  it('refuses a member another type in the hierarchy declares', { timeout: 60_000 }, async () => {
    await expect(invertBoolean.run(session, { symbol: 'active' })).rejects.toThrow(
      /is declared by other types in its hierarchy[\s\S]*Switch/,
    );
  });

  it('refuses a target that holds no boolean at all', { timeout: 60_000 }, async () => {
    await expect(invertBoolean.run(session, { symbol: 'Panel' })).rejects.toThrow(
      /is a ClassDeclaration; this tool inverts a function, a variable, a property, or a parameter/,
    );
  });

  it('refuses a newName that is the name it already has', { timeout: 60_000 }, async () => {
    await expect(
      invertBoolean.run(session, { symbol: 'isVisible', newName: 'isVisible' }),
    ).rejects.toThrow(/already called that/);
  });

  it('accepts a positional target as well as a name', { timeout: 60_000 }, async () => {
    const where = await positionOf(OPTIONS_TS, 'export function report(verbose');
    const result = await invertBoolean.run(session, {
      file: OPTIONS_TS,
      line: where.line,
      character: where.character + 'export function report('.length,
    });

    expect(result.sites.filter((site) => site.kind === 'argument')).toHaveLength(5);
    expect(await preview(result.edit, OPTIONS_TS)).toContain('  if (!verbose) {');
  });
});

describe('ts/refactors/invert-boolean apply mode', () => {
  it(
    'writes an inverted-and-renamed parameter and leaves the project clean',
    { timeout: 60_000 },
    async () => {
      await withProjectCopy(FIXTURE, async (copy, root) => {
        const result = await invertBoolean.run(copy, {
          symbol: 'verbose',
          newName: 'quiet',
          apply: true,
        });

        expect(result.applied).toBe(true);
        expect(result.newDiagnostics).toEqual([]);

        const options = await readFile(path.join(root, 'src/options.ts'), 'utf8');
        expect(options).toContain('export function report(quiet: boolean, label: string): string {');
        expect(options).toContain('  if (!quiet) {');

        const caller = await readFile(path.join(root, 'src/caller.ts'), 'utf8');
        expect(caller).toContain("return report(false, 'run');");
        expect(caller).toContain("return report(flag, 'run');");
        expect(caller).toContain("return report(!(a && b), 'run');");

        // The oracle: reopen the project that was actually written and
        // ask the compiler, rather than trusting the in-memory guard.
        const written = TsProjectSession.open(root);
        try {
          expect(semanticDiagnostics(written)).toEqual([]);
        } finally {
          await written.dispose();
        }
      });
    },
  );

  it('is its own inverse when run twice', { timeout: 60_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const before = await readFile(path.join(root, 'src/session.ts'), 'utf8');
      expect((await invertBoolean.run(copy, { symbol: 'isVisible', apply: true })).applied).toBe(
        true,
      );
      expect((await invertBoolean.run(copy, { symbol: 'isVisible', apply: true })).applied).toBe(
        true,
      );

      // Every branch is an involution — `!x`/`x`, `===`/`!==`,
      // `true`/`false` — so two runs have to land back on the source.
      expect(await readFile(path.join(root, 'src/session.ts'), 'utf8')).toBe(before);

      const written = TsProjectSession.open(root);
      try {
        expect(semanticDiagnostics(written)).toEqual([]);
      } finally {
        await written.dispose();
      }
    });
  });
});

describe('ts/refactors/invert-boolean fixture is stable', () => {
  it('leaves the fixture untouched after dry runs', async () => {
    expect(await readFile(SESSION_TS, 'utf8')).toContain('export let isVisible = false;');
    expect(await readFile(RULES_TS, 'utf8')).toContain('  return level === 2;');
  });
});
