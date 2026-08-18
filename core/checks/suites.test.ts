import { describe, expect, it } from 'vitest';
import { ToolRegistry, type Tool } from '../tool/index.js';
import { activeTools, narrowSuite, resolveSuite, suiteNames, type CheckSuite } from './suites.js';

const FINDINGS_OUT = { type: 'array' };
const EDIT_OUT = { type: 'object' };

function tool(name: string, outputSchema: Record<string, unknown>): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    outputSchema,
    run: () => Promise.resolve([]),
  };
}

const registry = new ToolRegistry();
registry.register(tool('ts/comments/long', FINDINGS_OUT));
registry.register(tool('ts/graph/cycles', FINDINGS_OUT));
registry.register(tool('ts/refactors/rename', EDIT_OUT));

const DEFAULTS: Readonly<Record<string, CheckSuite>> = {
  commit: { novelty: 'changed-lines', tools: { 'ts/comments/long': { level: 'warn' } } },
};

describe('resolveSuite', () => {
  it('falls back to the default suite when config names none', () => {
    expect(resolveSuite('commit', undefined, DEFAULTS, registry)).toEqual(DEFAULTS.commit);
    expect(resolveSuite('commit', { checks: {} }, DEFAULTS, registry)).toEqual(DEFAULTS.commit);
  });

  it('replaces a default suite outright rather than merging into it', () => {
    const config = {
      checks: { commit: { novelty: 'none', tools: { 'ts/graph/cycles': 'block' } } },
    };
    // long is gone, not inherited: a suite you write is the whole suite.
    expect(resolveSuite('commit', config, DEFAULTS, registry)).toEqual({
      novelty: 'none',
      tools: { 'ts/graph/cycles': { level: 'block' } },
    });
  });

  it('accepts the long entry form and keeps its tuning', () => {
    const config = {
      checks: {
        commit: {
          novelty: 'changed-file',
          tools: { 'ts/comments/long': { level: 'block', minSeverity: 'warning', input: { maxLines: 20 } } },
        },
      },
    };
    expect(resolveSuite('commit', config, DEFAULTS, registry).tools['ts/comments/long']).toEqual({
      level: 'block',
      config: { minSeverity: 'warning', input: { maxLines: 20 } },
    });
  });

  it('rejects a refactoring, naming why it cannot gate', () => {
    const config = { checks: { commit: { novelty: 'none', tools: { 'ts/refactors/rename': 'block' } } } };
    expect(() => resolveSuite('commit', config, DEFAULTS, registry)).toThrow(/cannot be scoped/);
  });

  it('rejects unknown suites, tools, levels and novelties', () => {
    expect(() => resolveSuite('nope', undefined, DEFAULTS, registry)).toThrow(/Unknown check suite/);
    expect(() =>
      resolveSuite('commit', { checks: { commit: { novelty: 'none', tools: { 'ts/nope/nope': 'block' } } } }, DEFAULTS, registry),
    ).toThrow(/unknown tool/);
    expect(() =>
      resolveSuite('commit', { checks: { commit: { novelty: 'none', tools: { 'ts/comments/long': 'maybe' } } } }, DEFAULTS, registry),
    ).toThrow(/must be one of block, warn, off/);
    expect(() =>
      resolveSuite('commit', { checks: { commit: { novelty: 'sometimes', tools: {} } } }, DEFAULTS, registry),
    ).toThrow(/novelty must be one of/);
    expect(() =>
      resolveSuite('commit', { checks: { commit: { novelty: 'none', tools: [] } } }, DEFAULTS, registry),
    ).toThrow(/tools must be an object/);
  });
});

describe('suiteNames', () => {
  it('unions the defaults with the configured suites', () => {
    expect(suiteNames({ checks: { release: {} } }, DEFAULTS)).toEqual(['commit', 'release']);
  });
});

describe('activeTools', () => {
  it('drops the tools switched off and sorts the rest', () => {
    const suite: CheckSuite = {
      novelty: 'none',
      tools: {
        'ts/graph/cycles': { level: 'block' },
        'ts/comments/long': { level: 'off' },
      },
    };
    expect(activeTools(suite).map((t) => t.name)).toEqual(['ts/graph/cycles']);
  });
});

describe('narrowSuite', () => {
  const suite: CheckSuite = {
    novelty: 'changed-lines',
    tools: {
      'ts/a': { level: 'block' },
      'sw/a': { level: 'warn' },
      'sw/b': { level: 'off' },
    },
  };

  it('keeps only the tools the predicate admits', () => {
    const { suite: narrowed } = narrowSuite(suite, (name) => name.startsWith('ts/'));
    expect(Object.keys(narrowed.tools)).toEqual(['ts/a']);
    expect(narrowed.novelty).toBe('changed-lines');
  });

  // Silence from a gate that dropped half its tools reads exactly like
  // a gate that ran and found nothing, so the caller has to be able to
  // tell the difference.
  it('reports what it dropped, ignoring tools that were already off', () => {
    const { dropped } = narrowSuite(suite, (name) => name.startsWith('ts/'));
    expect(dropped).toEqual(['sw/a']);
  });

  it('narrows to nothing when no tool matches', () => {
    const { suite: narrowed, dropped } = narrowSuite(suite, () => false);
    expect(activeTools(narrowed)).toEqual([]);
    expect(dropped).toEqual(['sw/a', 'ts/a']);
  });
});
