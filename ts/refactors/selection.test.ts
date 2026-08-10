import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../project/index.js';
import { locateSelection } from './selection.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/refactor-core-ts');
const PRICING = 'src/pricing.ts';

const session = TsProjectSession.open(FIXTURE);
afterAll(() => session.dispose());

const locate = (select: string, within?: string) =>
  locateSelection(session, within === undefined ? { file: PRICING, select } : { file: PRICING, select, within });

describe('locateSelection', () => {
  it('locates a statement run written with different whitespace', { timeout: 30_000 }, () => {
    const located = locate('let total = 0;\nfor (const line of lines) { total += line.qty * line.unit; }');

    expect(located.kind).toBe('statements');
    // The range covers the real source, with its own indentation intact.
    expect(located.text).toContain('for (const line of lines) {');
    expect(located.text.trimEnd().endsWith('}')).toBe(true);
  });

  it('ignores comments in the selection', () => {
    const located = locate('const taxed = total * (1 + taxRate); // the tax');

    expect(located.kind).toBe('statements');
    expect(located.text).toBe('const taxed = total * (1 + taxRate);');
  });

  it('reads a trailing semicolon as "I meant the statement"', () => {
    expect(locate('total += line.qty * line.unit;').kind).toBe('statements');
    expect(locate('line.qty * line.unit').kind).toBe('expression');
  });

  it('locates an expression nested inside a larger one', () => {
    const located = locate('Math.round(taxed * 100)');

    expect(located.kind).toBe('expression');
    expect(located.text).toBe('Math.round(taxed * 100)');
  });

  it('survives template literals and regex, which defeat a raw scanner', () => {
    // A raw scanner reads the `}` closing `${…}` as a plain brace and
    // lets the next backtick open a template that eats the rest of the
    // file; parser tokens do not have that problem.
    const template = locate('const heading = `cart of ${String(lines.length)} items`;');
    expect(template.kind).toBe('statements');

    const regex = locate("const safe = /[^a-z ]/i.test(label) ? 'unnamed' : label;");
    expect(regex.text).toContain('/[^a-z ]/i');
  });

  it('locates a type, which only parses in type position', () => {
    // `{ ok: boolean; latencyMs: number }` also parses cleanly as a
    // block of labelled statements, so the code reading is tried first
    // and finds nothing; the type reading is what resolves it.
    const located = locate('{ ok: boolean; latencyMs: number }');

    expect(located.kind).toBe('type');
    expect(located.text).toBe('{ ok: boolean; latencyMs: number }');
  });

  it('reports a type literal written twice, which is what dedupe acts on', () => {
    // `Endpoint`'s right-hand side and connect()'s parameter type.
    expect(() => locate('{ host: string; port: number }')).toThrow(/occurs 2 times/);
  });

  it('reaches a selection inside a callback, which has no enclosing named function', () => {
    const located = locate('const scaled = line.qty * 2;');

    expect(located.kind).toBe('statements');
    expect(located.text).toBe('const scaled = line.qty * 2;');
  });

  it('refuses an ambiguous selection, naming the lines to disambiguate', () => {
    // `total += lines[0]!.qty;` appears in both of twice()'s branches.
    expect(() => locate('total += lines[0]!.qty;')).toThrow(/occurs 2 times.*lines \d+, \d+/s);
  });

  it('accepts an ambiguous selection once a neighbour makes it unique', () => {
    const located = locate('if (lines.length > 1) { total += lines[0]!.qty; }');

    expect(located.kind).toBe('statements');
    expect(located.text).toContain('lines.length > 1');
  });

  it('narrows a selection shared between two functions with within', () => {
    // `let total = 0;` opens both totalPrice() and twice().
    expect(() => locate('let total = 0;')).toThrow(/occurs 2 times/);

    const located = locate('let total = 0;', 'totalPrice');
    expect(located.kind).toBe('statements');
    expect(located.text).toBe('let total = 0;');
  });

  it('refuses a selection that is not a whole node', () => {
    // Half an expression must fail outright rather than being widened
    // to the nearest node, which is what TypeScript would do with it.
    expect(() => locate('qty * line.uni')).toThrow(/not a whole statement/);
    expect(() => locate('taxed * 100) / 100')).toThrow(/does not parse|not a whole statement/);
  });

  it('refuses code that is not in the file at all', () => {
    expect(() => locate('const nothing = 1;')).toThrow(/not a whole statement/);
  });

  it('refuses an unknown or ambiguous within', () => {
    expect(() => locate('let total = 0;', 'noSuchFunction')).toThrow(/No function named/);
  });
});
