import type { CheckSuite } from './../core/checks/index.js';

/**
 * What an unattended agent may act on. Empty, and the reasons are
 * ts/checks.ts's unchanged: comment.long's threshold is taste, and an
 * agent shortening every comment to satisfy a number makes the code
 * worse; comment.llm-tell is an LLM scrubbing its own tells, which is
 * circular.
 *
 * One thing to weigh before anything joins this list. The TypeScript
 * list's warrant is that a typecheck and a test run can vouch for the
 * fix. This pack has no diagnosticsIntroducedBy, so nothing here can
 * vouch for an edit at all — which makes a prose-only restriction
 * load-bearing rather than merely conservative.
 */
export const SWIFT_FIXABLE_CODES: ReadonlySet<string> = new Set<string>([]);

/**
 * The default suites.
 *
 * ts/checks.ts sets its block/warn split by running each tool against
 * this repository, on the argument that a tool firing on a clean,
 * actively maintained codebase is firing on taste. There is no Swift
 * here, so three real projects stand in for the home project:
 * hotseat-app (204 files, SwiftPM), drum/ios (82, Xcode) and War (393,
 * Xcode) — 679 files across two build systems and three eras of style.
 *
 * A tool blocks only if it reports zero on all three. That is stricter
 * than TypeScript's "nothing here or close to it", deliberately: this
 * repository can be re-measured on every commit and those corpora
 * cannot, so the rule should not carry a clause to argue about.
 *
 * Measured, and the argument for the levels below:
 *
 *   swift/comments/long        35 / 0 / 43
 *   swift/comments/llm-tells   27 / 19 / 0
 *
 * Neither is silent on all three, so neither blocks — the same outcome
 * the TypeScript comment family reached, by the same rule.
 *
 * Novelty ports directly: both tools anchor on the offending comment,
 * which is what changed-lines needs. Neither belongs in `push`, where
 * a whole-project baseline run on an Xcode project costs tens of
 * seconds per the roadmap's §3.
 */
export const SWIFT_DEFAULT_CHECKS: Readonly<Record<string, CheckSuite>> = {
  commit: {
    novelty: 'changed-lines',
    tools: {
      'swift/comments/long': { level: 'warn' },
      'swift/comments/llm-tells': { level: 'warn' },
    },
  },
  claude: {
    novelty: 'changed-file',
    tools: {
      'swift/comments/llm-tells': { level: 'warn' },
      'swift/comments/long': { level: 'warn' },
    },
  },
};
