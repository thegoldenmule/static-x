import type { Baseline } from './baseline.js';
import type { CheckSuite, Novelty } from './suites.js';
import type { ToolOutcome } from './run.js';

/**
 * Deciding how much stricter a suite is allowed to become, given what
 * the project reports right now.
 *
 * The division of labour with `baseline` is the whole design: baseline
 * **accepts** whatever it finds, so it can turn a gate on for a codebase
 * that has never had one. Ratchet **only tightens** — it will not record
 * a finding that was not there before, and it refuses to do anything at
 * all while something has regressed. Recording a regression is exactly
 * the failure a ratchet exists to prevent, and doing it silently as part
 * of "tightening" would be perverse.
 *
 * Nothing here runs from a hook. A ratchet in CI or in pre-push locks in
 * whatever strictness one machine happened to reach on a good day, and
 * the next person to push is blocked by someone else's luck.
 */

export interface BaselineDelta {
  /** Total findings the baseline accounted for before and after. */
  before: number;
  after: number;
  /** Entries that reproduce fewer times than the baseline allows. */
  resolved: { key: string; before: number; after: number }[];
  /** Entries that reproduce more often — a ratchet cannot proceed. */
  regressed: { key: string; before: number; after: number }[];
}

export interface Promotion {
  tool: string;
  from: 'warn';
  to: 'block';
  /** Why it is safe: the count that proves it. */
  reason: string;
}

export interface RatchetPlan {
  suite: string;
  /** Absent when the suite does not use a baseline. */
  delta?: BaselineDelta;
  promotions: Promotion[];
  /** Set when the baseline emptied and the policy can be dropped. */
  novelty?: { from: Novelty; to: Novelty };
  /** True when the baseline file has become an empty formality. */
  retireBaseline: boolean;
  /** Why nothing can be done, when that is the answer. */
  blocked?: string;
}

export function isEmptyPlan(plan: RatchetPlan): boolean {
  return (
    plan.promotions.length === 0 &&
    plan.novelty === undefined &&
    !plan.retireBaseline &&
    (plan.delta === undefined || plan.delta.resolved.length === 0)
  );
}

/**
 * A tool is promotable when it reports nothing across the whole project
 * — not merely nothing new. Promoting on "nothing new" would hide a
 * trap: the tool's findings would still be sitting in the baseline, and
 * the next deliberate `static-x baseline` would turn them all into
 * blocking findings at once.
 */
function promotions(suite: CheckSuite, outcomes: readonly ToolOutcome[]): Promotion[] {
  const found: Promotion[] = [];
  for (const outcome of outcomes) {
    if (outcome.level !== 'warn' || outcome.findings.length > 0) continue;
    found.push({
      tool: outcome.tool,
      from: 'warn',
      to: 'block',
      reason: 'reports nothing across the project',
    });
  }
  return found.sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

/**
 * `current` is the suite run unfiltered over the whole project — the
 * only view a ratchet can reason about. Ratcheting from a changed-lines
 * run would tighten a gate on the strength of one commit's worth of
 * evidence.
 */
export function planRatchet(input: {
  suiteName: string;
  suite: CheckSuite;
  outcomes: readonly ToolOutcome[];
  current: ReadonlyMap<string, number>;
  baseline?: Baseline | undefined;
}): RatchetPlan {
  const { suiteName, suite, outcomes, current, baseline } = input;
  const plan: RatchetPlan = {
    suite: suiteName,
    promotions: promotions(suite, outcomes),
    retireBaseline: false,
  };

  if (suite.novelty !== 'baseline') return plan;

  if (!baseline) {
    return {
      ...plan,
      promotions: [],
      blocked: 'no baseline recorded — run `static-x baseline` first, then ratchet it down',
    };
  }

  const resolved: BaselineDelta['resolved'] = [];
  const regressed: BaselineDelta['regressed'] = [];
  for (const [key, was] of baseline) {
    const now = current.get(key) ?? 0;
    if (now < was) resolved.push({ key, before: was, after: now });
  }
  for (const [key, now] of current) {
    const was = baseline.get(key) ?? 0;
    if (now > was) regressed.push({ key, before: was, after: now });
  }

  const sum = (counts: Iterable<number>) => [...counts].reduce((total, n) => total + n, 0);
  const delta: BaselineDelta = {
    before: sum(baseline.values()),
    after: sum(current.values()),
    resolved: resolved.sort((a, b) => (a.key < b.key ? -1 : 1)),
    regressed: regressed.sort((a, b) => (a.key < b.key ? -1 : 1)),
  };

  if (regressed.length > 0) {
    // Refusing wholesale rather than banking the improvements: writing a
    // baseline that accommodates the regression is what `baseline` is
    // for, and it should take saying so out loud.
    return {
      ...plan,
      promotions: [],
      delta,
      blocked:
        `${String(regressed.length)} finding${regressed.length === 1 ? '' : 's'} regressed since ` +
        'the baseline was recorded — fix them, or accept them deliberately with `static-x baseline`',
    };
  }

  plan.delta = delta;
  if (delta.after === 0) {
    plan.novelty = { from: 'baseline', to: 'none' };
    plan.retireBaseline = true;
  }
  return plan;
}
