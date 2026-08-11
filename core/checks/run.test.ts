import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Finding } from '../tool/index.js';
import { runSuite, type Dispatcher } from './run.js';
import type { CheckSuite } from './suites.js';

const ROOT = path.resolve('/repo');
const at = (file: string) => path.join(ROOT, file);

function finding(file: string, line: number, code = 'comment.long', severity: Finding['severity'] = 'info'): Finding {
  return {
    file: at(file),
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
    code,
    message: code,
    severity,
  };
}

/** Records what each tool was asked for, and answers from a script. */
function dispatcher(answers: Record<string, Finding[]>) {
  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  const impl: Dispatcher = {
    call: (tool, _root, input) => {
      calls.push({ tool, input: input as Record<string, unknown> });
      return Promise.resolve(answers[tool] ?? []);
    },
  };
  return { impl, calls };
}

describe('runSuite', () => {
  it('splits findings by level, so warn tools report without rejecting', async () => {
    const suite: CheckSuite = {
      novelty: 'none',
      tools: {
        'ts/async/floating-promises': { level: 'block' },
        'ts/comments/long': { level: 'warn' },
        'ts/comments/llm-tells': { level: 'off' },
      },
    };
    const { impl, calls } = dispatcher({
      'ts/async/floating-promises': [finding('a.ts', 1, 'async.floating')],
      'ts/comments/long': [finding('a.ts', 2)],
      'ts/comments/llm-tells': [finding('a.ts', 3)],
    });

    const report = await runSuite({ suite, rootPath: ROOT, dispatcher: impl });
    expect(report.blocking.map((f) => f.code)).toEqual(['async.floating']);
    expect(report.advisory.map((f) => f.code)).toEqual(['comment.long']);
    // The tool set to off never ran at all.
    expect(calls.map((c) => c.tool)).toEqual(['ts/async/floating-promises', 'ts/comments/long']);
  });

  it('scopes dispatch to the changed files for a per-file suite', async () => {
    const suite: CheckSuite = { novelty: 'changed-lines', tools: { 'ts/comments/long': { level: 'block' } } };
    const { impl, calls } = dispatcher({ 'ts/comments/long': [] });
    await runSuite({
      suite,
      rootPath: ROOT,
      dispatcher: impl,
      changes: { files: [at('a.ts')], lines: new Map() },
    });
    expect(calls[0]?.input['files']).toEqual([at('a.ts')]);
  });

  it('passes no scope for a baseline suite, whose finding is often elsewhere', async () => {
    const suite: CheckSuite = { novelty: 'baseline', tools: { 'ts/graph/dead-exports': { level: 'warn' } } };
    const { impl, calls } = dispatcher({ 'ts/graph/dead-exports': [] });
    await runSuite({
      suite,
      rootPath: ROOT,
      dispatcher: impl,
      changes: { files: [at('a.ts')] },
      baseline: new Map(),
    });
    expect(calls[0]?.input).not.toHaveProperty('files');
  });

  it('applies the entry tuning on top of what dispatch already filtered', async () => {
    const suite: CheckSuite = {
      novelty: 'none',
      tools: { 'ts/types/loopholes': { level: 'block', config: { minSeverity: 'warning' } } },
    };
    const { impl } = dispatcher({
      'ts/types/loopholes': [
        finding('a.ts', 1, 'types.assertion', 'info'),
        finding('a.ts', 2, 'types.assertion', 'warning'),
      ],
    });
    const report = await runSuite({ suite, rootPath: ROOT, dispatcher: impl });
    expect(report.blocking.map((f) => f.severity)).toEqual(['warning']);
  });

  it('merges the entry input into the tool call', async () => {
    const suite: CheckSuite = {
      novelty: 'none',
      tools: { 'ts/comments/long': { level: 'warn', config: { input: { maxLines: 20 } } } },
    };
    const { impl, calls } = dispatcher({ 'ts/comments/long': [] });
    await runSuite({ suite, rootPath: ROOT, dispatcher: impl });
    expect(calls[0]?.input).toEqual({ maxLines: 20 });
  });

  it('narrows by novelty and reports the policy it actually applied', async () => {
    const suite: CheckSuite = { novelty: 'changed-lines', tools: { 'ts/comments/long': { level: 'block' } } };
    const { impl } = dispatcher({ 'ts/comments/long': [finding('a.ts', 3), finding('a.ts', 40)] });
    const report = await runSuite({
      suite,
      rootPath: ROOT,
      dispatcher: impl,
      changes: { files: [at('a.ts')], lines: new Map([[at('a.ts'), new Set([40])]]) },
    });
    expect(report.novelty).toBe('changed-lines');
    expect(report.blocking.map((f) => f.range.start.line)).toEqual([40]);
    expect(report.outcomes[0]?.findings).toHaveLength(1);
  });

  it('carries the degradation note out to the caller', async () => {
    const suite: CheckSuite = { novelty: 'baseline', tools: { 'ts/graph/cycles': { level: 'block' } } };
    const { impl } = dispatcher({ 'ts/graph/cycles': [finding('a.ts', 1, 'graph.cycle', 'warning')] });
    const report = await runSuite({ suite, rootPath: ROOT, dispatcher: impl });
    expect(report.novelty).toBe('none');
    expect(report.note).toMatch(/static-x baseline/);
    expect(report.blocking).toHaveLength(1);
  });
});
