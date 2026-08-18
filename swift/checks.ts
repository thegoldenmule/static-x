import type { CheckSuite } from './../core/checks/index.js';

/**
 * What an unattended agent may act on. Both entries are prose: wrong
 * prose is the defect, and no edit to a comment can change behaviour.
 *
 * comment.long and comment.llm-tell stay out for ts/checks.ts's
 * reasons — the threshold is taste, and an LLM scrubbing its own tells
 * is circular.
 *
 * The restriction to prose is load-bearing here in a way it is not in
 * TypeScript. That list's warrant is that a typecheck and a test run
 * can vouch for the fix; this pack has no diagnosticsIntroducedBy, so
 * nothing here can vouch for an edit at all. Anything that changes
 * behaviour must stay off this list until that changes.
 */
export const SWIFT_FIXABLE_CODES: ReadonlySet<string> = new Set<string>([
  'comment.stale-ref',
  'comment.stale-param',
]);

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
 *   swift/comments/stale-refs  115 / 6 / 62   (70 / 0 / 1 at medium)
 *
 * None is silent on all three, so none blocks — the same outcome the
 * TypeScript comment family reached, by the same rule.
 *
 * long and llm-tells anchor on the offending comment, which is what
 * changed-lines needs, and cost one semantic-token request per changed
 * file. stale-refs cannot use changed-lines: a rename in one file
 * stales a comment in another, so the commit that broke it need not
 * have touched the file the finding lands in — the same argument that
 * puts graph/dead-exports on a baseline. It also has to index every
 * source file to answer at all, so it belongs where a whole-project
 * run is expected.
 *
 * minConfidence medium drops the bare-prose tier: 115 -> 70 on the
 * largest corpus, against the TypeScript tool's 234 -> 132 here.
 */
export const SWIFT_DEFAULT_CHECKS: Readonly<Record<string, CheckSuite>> = {
  commit: {
    novelty: 'changed-lines',
    tools: {
      'swift/comments/long': { level: 'warn' },
      'swift/comments/llm-tells': { level: 'warn' },
    },
  },
  push: {
    novelty: 'baseline',
    tools: {
      'swift/comments/stale-refs': { level: 'warn', config: { minConfidence: 'medium' } },
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
