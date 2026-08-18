import type { CheckSuite } from './../core/checks/index.js';

/**
 * What an unattended agent may act on. Empty while the pack ships only
 * comments/long and comments/llm-tells, and deliberately so: both have
 * thresholds that are taste, an agent shortening every comment to
 * satisfy a number makes the code worse, and an LLM scrubbing its own
 * tells is circular. Those are ts/checks.ts's reasons, unchanged.
 *
 * One thing to keep in view before anything joins this list: the
 * TypeScript list's warrant is that a typecheck and a test run can
 * vouch for the fix, and this pack has no diagnosticsIntroducedBy. That
 * makes a prose-only restriction load-bearing here rather than merely
 * conservative.
 */
export const SWIFT_FIXABLE_CODES: ReadonlySet<string> = new Set<string>([]);

/**
 * The default suites.
 *
 * ts/checks.ts decides its block/warn split by running each tool
 * against this repository, on the argument that a tool firing on a
 * clean, actively maintained codebase is firing on taste. There is no
 * Swift here, so the corpus stands in for the home project: hotseat-app
 * (204 files, SwiftPM), drum/ios (82, Xcode) and War (393, Xcode) —
 * 679 files across two build systems and three eras of Swift style.
 *
 * A tool blocks only if it reports zero on all three. That is a
 * stricter bar than TypeScript's "nothing here or close to it", and
 * deliberately: this repository can be re-measured on every commit and
 * those corpora cannot, so the rule should not have a clause to argue
 * about.
 */
export const SWIFT_DEFAULT_CHECKS: Readonly<Record<string, CheckSuite>> = {};
