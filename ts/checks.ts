import type { CheckSuite } from '../core/checks/index.js';

/**
 * The suites a TypeScript project gets without writing any config, and
 * the ones `static-x install` materializes into static-x.json so they
 * can be edited.
 *
 * The block/warn split is measured rather than chosen. Run every
 * analysis tool over this repository — 141 source files, linted, no
 * outstanding work — and only two report nothing: `async/floating-
 * promises` and `graph/cycles`. Those two find defects; the rest find
 * things that are true, worth knowing, and a matter of degree. So those
 * two block, and everything else reports without blocking. A gate that
 * blocks on taste is a gate people learn to pass with --no-verify, and
 * then it is worth nothing on the day it catches a dropped promise.
 *
 * The tuning attached to individual entries is what keeps that promise
 * for the tools that do block. Its effect on this repository, which is
 * the only honest way to state it:
 *
 *   ts/types/loopholes  minSeverity warning   328 findings -> 2
 *   ts/dupes/functions  minSeverity warning    83 findings -> 63 (exact only)
 *   ts/comments/stale-refs  minConfidence medium  234 -> 132
 */
export const TS_DEFAULT_CHECKS: Readonly<Record<string, CheckSuite>> = {
  /**
   * Staged files, line-scoped, ~1.0s for five tools over one session.
   * `graph/dead-exports` is deliberately absent: it reports in the file
   * that declares an export, which is not the file whose last import
   * you just deleted, so a commit-scoped run misses exactly the case
   * that made it dead.
   */
  commit: {
    novelty: 'changed-lines',
    tools: {
      'ts/async/floating-promises': { level: 'block' },
      // Scopeable despite being a whole-project analysis: the finding
      // carries data.files, which the ferry's scope filter matches on.
      'ts/graph/cycles': { level: 'block' },
      'ts/dupes/functions': { level: 'warn', config: { minSeverity: 'warning' } },
      'ts/comments/long': { level: 'warn' },
      'ts/comments/llm-tells': { level: 'warn' },
    },
  },

  /**
   * Whole project against the recorded baseline, ~0.6s. This is where
   * the graph tools belong: a cycle or a dead export is a property of
   * the project, and the file that introduced it is usually not the
   * file that reports it.
   */
  push: {
    novelty: 'baseline',
    tools: {
      'ts/graph/cycles': { level: 'block' },
      'ts/graph/dead-exports': { level: 'warn' },
      'ts/comments/stale-refs': { level: 'warn', config: { minConfidence: 'medium' } },
      'ts/dupes/functions': { level: 'warn', config: { minSeverity: 'warning' } },
    },
  },

  /**
   * The file Claude just wrote, whole — not line-scoped, because a
   * model that rewrites a file wholesale leaves a diff whose hunks say
   * nothing useful about which lines are its own.
   *
   * `types/loopholes` blocks here and nowhere else. At minSeverity
   * warning it selects assertions to `any`, double casts, and
   * suppression directives — the specific corners a model cuts to make
   * an error go away — and leaves ordinary assertions alone.
   */
  claude: {
    novelty: 'changed-file',
    tools: {
      'ts/async/floating-promises': { level: 'block' },
      'ts/types/loopholes': { level: 'block', config: { minSeverity: 'warning' } },
      'ts/comments/llm-tells': { level: 'warn' },
      'ts/comments/long': { level: 'warn' },
    },
  },
};
