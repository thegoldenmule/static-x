import { describe, expect, it } from 'vitest';
import type { Finding } from '../tool/index.js';
import { isEmptyPlan, planRatchet } from './ratchet.js';
import type { ToolOutcome } from './run.js';
import type { CheckSuite } from './suites.js';

const ROOT = '/repo';

function outcome(tool: string, level: ToolOutcome['level'], findings = 0): ToolOutcome {
  const finding: Finding = {
    file: `${ROOT}/a.ts`,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    code: 'x',
    message: 'x',
    severity: 'info',
  };
  return { tool, level, findings: Array.from({ length: findings }, () => finding) };
}

const baselineSuite: CheckSuite = {
  novelty: 'baseline',
  tools: { 'ts/graph/dead-exports': { level: 'warn' }, 'ts/graph/cycles': { level: 'warn' } },
};

function plan(options: {
  suite?: CheckSuite;
  outcomes?: ToolOutcome[];
  current?: [string, number][];
  baseline?: [string, number][] | undefined;
}) {
  return planRatchet({
    suiteName: 'push',
    suite: options.suite ?? baselineSuite,
    outcomes: options.outcomes ?? [],
    current: new Map(options.current ?? []),
    baseline: options.baseline === undefined ? undefined : new Map(options.baseline),
  });
}

describe('planRatchet', () => {
  describe('the baseline', () => {
    it('reports what stopped reproducing', () => {
      const result = plan({
        baseline: [['a.ts|dead|X', 2], ['a.ts|dead|Y', 1]],
        current: [['a.ts|dead|X', 1]],
      });
      expect(result.delta?.before).toBe(3);
      expect(result.delta?.after).toBe(1);
      expect(result.delta?.resolved).toEqual([
        { key: 'a.ts|dead|X', before: 2, after: 1 },
        { key: 'a.ts|dead|Y', before: 1, after: 0 },
      ]);
    });

    it('refuses entirely while anything regressed, banking nothing', () => {
      // Ten fixes and one regression is still a refusal: writing a
      // baseline that accommodates the regression is what `baseline` is
      // for, and it should take saying so out loud.
      const result = plan({
        baseline: [['a.ts|dead|X', 5], ['a.ts|dead|Y', 0]],
        current: [['a.ts|dead|X', 1], ['a.ts|dead|Y', 1]],
      });
      expect(result.blocked).toMatch(/1 finding regressed/);
      expect(result.delta?.regressed).toEqual([{ key: 'a.ts|dead|Y', before: 0, after: 1 }]);
      expect(result.promotions).toEqual([]);
    });

    it('says what to do when there is no baseline to tighten', () => {
      const result = plan({ baseline: undefined, current: [['a.ts|dead|X', 1]] });
      expect(result.blocked).toMatch(/run `static-x baseline` first/);
    });

    it('retires the policy once the baseline empties', () => {
      const result = plan({ baseline: [['a.ts|dead|X', 1]], current: [] });
      expect(result.novelty).toEqual({ from: 'baseline', to: 'none' });
      expect(result.retireBaseline).toBe(true);
    });

    it('leaves the policy alone while anything remains', () => {
      const result = plan({ baseline: [['a.ts|dead|X', 2]], current: [['a.ts|dead|X', 1]] });
      expect(result.novelty).toBeUndefined();
      expect(result.retireBaseline).toBe(false);
    });
  });

  describe('promotion', () => {
    const suite: CheckSuite = { novelty: 'none', tools: {} };

    it('promotes a warn tool that reports nothing at all', () => {
      const result = plan({
        suite,
        outcomes: [outcome('ts/graph/cycles', 'warn', 0), outcome('ts/comments/long', 'warn', 3)],
      });
      expect(result.promotions).toEqual([
        { tool: 'ts/graph/cycles', from: 'warn', to: 'block', reason: 'reports nothing across the project' },
      ]);
    });

    it('leaves block and off alone', () => {
      const result = plan({
        suite,
        outcomes: [outcome('ts/graph/cycles', 'block', 0), outcome('ts/comments/long', 'off', 0)],
      });
      expect(result.promotions).toEqual([]);
    });

    it('does not promote on the strength of a baseline hiding the findings', () => {
      // The findings would still be in the baseline; the next deliberate
      // re-record would turn all of them into blocking findings at once.
      const result = plan({
        outcomes: [outcome('ts/graph/dead-exports', 'warn', 4)],
        baseline: [['a.ts|dead|X', 4]],
        current: [['a.ts|dead|X', 4]],
      });
      expect(result.promotions).toEqual([]);
    });
  });

  describe('isEmptyPlan', () => {
    it('is true when there is nothing to do', () => {
      expect(isEmptyPlan(plan({ baseline: [['a|b|c', 1]], current: [['a|b|c', 1]] }))).toBe(true);
    });

    it('is false once anything can be tightened', () => {
      expect(isEmptyPlan(plan({ baseline: [['a|b|c', 2]], current: [['a|b|c', 1]] }))).toBe(false);
      expect(
        isEmptyPlan(plan({ suite: { novelty: 'none', tools: {} }, outcomes: [outcome('t', 'warn', 0)] })),
      ).toBe(false);
    });
  });
});
