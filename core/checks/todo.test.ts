import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Finding } from '../tool/index.js';
import { planTodo } from './todo.js';

const ROOT = path.resolve('/repo');

function finding(file: string, code: string, name: string, line = 0): Finding {
  return {
    file: path.join(ROOT, file),
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
    code,
    message: code,
    severity: 'warning',
    data: { name },
  };
}

const FIXABLE = new Set(['comment.stale-ref', 'dupes.function']);

/** Groups findings under the tool whose name their code implies. */
function outcomesFor(findings: Finding[]): { tool: string; findings: Finding[] }[] {
  const TOOL: Record<string, string> = {
    'comment.stale-ref': 'ts/comments/stale-refs',
    'dupes.function': 'ts/dupes/functions',
    'graph.dead-export': 'ts/graph/dead-exports',
  };
  const by = new Map<string, Finding[]>();
  for (const f of findings) {
    const tool = TOOL[f.code] ?? f.code;
    const list = by.get(tool);
    if (list) list.push(f);
    else by.set(tool, [f]);
  }
  return [...by].map(([tool, fs]) => ({ tool, findings: fs }));
}

function plan(findings: Finding[], baseline: [string, number][], only?: string[]) {
  return planTodo({
    outcomes: outcomesFor(findings),
    baseline: new Map(baseline),
    rootPath: ROOT,
    fixable: FIXABLE,
    ...(only ? { only: new Set(only) } : {}),
  });
}

describe('planTodo', () => {
  it('lists what the baseline accounts for, grouped by file', () => {
    const todo = plan(
      [
        finding('a.ts', 'comment.stale-ref', 'X', 5),
        finding('a.ts', 'comment.stale-ref', 'Y', 2),
        finding('b.ts', 'comment.stale-ref', 'Z'),
      ],
      [
        ['a.ts|comment.stale-ref|X', 1],
        ['a.ts|comment.stale-ref|Y', 1],
        ['b.ts|comment.stale-ref|Z', 1],
      ],
    );
    expect(todo.count).toBe(3);
    // Most findings first — one edit and one test run clears the file.
    expect(todo.files.map((f) => f.file)).toEqual(['a.ts', 'b.ts']);
    // Within a file, in source order.
    expect(todo.files[0]?.items.map((i) => i.finding.range.start.line)).toEqual([2, 5]);
  });

  it('carries the tool, which is the config path an ignore entry needs', () => {
    // comment.stale-ref cannot be turned into ts/comments/stale-refs by
    // rule: the code is singular, the tool plural, and stale-param comes
    // from the same tool. Anyone writing an ignore would be guessing.
    const todo = plan(
      [finding('a.ts', 'comment.stale-ref', 'X')],
      [['a.ts|comment.stale-ref|X', 1]],
    );
    expect(todo.files[0]?.items[0]?.tool).toBe('ts/comments/stale-refs');
  });

  it('excludes a regression, which is check and ratchet business', () => {
    // Working the backlog must not mean fixing damage just done: only
    // findings the baseline already covers belong in the queue.
    const todo = plan(
      [finding('a.ts', 'comment.stale-ref', 'known'), finding('a.ts', 'comment.stale-ref', 'new')],
      [['a.ts|comment.stale-ref|known', 1]],
    );
    expect(todo.count).toBe(1);
    expect(todo.backlog).toBe(1);
    expect(todo.files[0]?.items[0]?.finding.data?.['name']).toBe('known');
  });

  it('counts occurrences, so a fourth of three baselined is not queued', () => {
    const four = Array.from({ length: 4 }, (_, i) => finding('a.ts', 'dupes.function', 'dup', i));
    const todo = plan(four, [['a.ts|dupes.function|dup', 3]]);
    expect(todo.count).toBe(3);
  });

  it('holds back codes an agent should not act on, and says how many', () => {
    const todo = plan(
      [
        finding('a.ts', 'comment.stale-ref', 'X'),
        finding('a.ts', 'graph.dead-export', 'Y'),
        finding('b.ts', 'graph.dead-export', 'Z'),
      ],
      [
        ['a.ts|comment.stale-ref|X', 1],
        ['a.ts|graph.dead-export|Y', 1],
        ['b.ts|graph.dead-export|Z', 1],
      ],
    );
    expect(todo.count).toBe(1);
    expect(todo.backlog).toBe(3);
    expect(todo.excluded.get('graph.dead-export')).toBe(2);
  });

  it('narrows further when the caller names codes', () => {
    const todo = plan(
      [finding('a.ts', 'comment.stale-ref', 'X'), finding('a.ts', 'dupes.function', 'Y')],
      [['a.ts|comment.stale-ref|X', 1], ['a.ts|dupes.function|Y', 1]],
      ['dupes.function'],
    );
    expect(todo.count).toBe(1);
    expect(todo.files[0]?.items[0]?.finding.code).toBe('dupes.function');
  });

  it('is empty when the baseline is', () => {
    const todo = plan([finding('a.ts', 'comment.stale-ref', 'X')], []);
    expect(todo).toMatchObject({ count: 0, backlog: 0, files: [] });
  });
});
