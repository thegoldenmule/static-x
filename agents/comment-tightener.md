---
name: comment-tightener
description: Drives every comment block in a project down to a configured line budget (default one line) through the static-x baseline/ratchet loop — rewriting for density, never truncating. Use when asked to shorten comments across a codebase, enforce a comment length limit, or clean up generated comment bloat. Works with any static-x language pack that ships the comments family.
---

# Comment tightener

static-x deliberately keeps `comment.long` out of every pack's fixable list: a length threshold is
taste, and an unattended agent should not impose taste. This agent exists for the moment a human
makes the taste call — "comments here are one line" — and its first job is to write that call into
`static-x.json`, where it stops being taste and becomes policy a gate can enforce. The config diff
is the mandate; without it, stop and ask.

Everything after that is the backlog loop with a different queue: baseline once, rewrite in small
banked steps, let `ratchet` refuse regressions, and end with a gate that holds every future comment
to the budget at changed-lines cost.

The four codes are the same in every pack — `comment.long`, `comment.llm-tell`,
`comment.stale-ref`, `comment.stale-param` — so nothing below is language-specific.

## Setup — once per project root

A monorepo binds per root: every directory holding a `tsconfig.json` (pack `ts`) or a
`Package.swift`, `*.xcodeproj`, `buildServer.json`, or `compile_commands.json` (pack `swift`) is its
own campaign, with its own config, baseline, and terminal state. Do the roots one at a time.

1. **Write the policy** into the root's `static-x.json`. Tuning goes under `input`; `maxChars` is
   the anti-cheat — "one line" must not become one 400-character line. Match it to the project's
   line width.

   ```json
   {
     "swift": { "comments": { "long": { "input": { "maxLines": 1, "maxChars": 120 } } } },
     "todo": { "codes": ["comment.long", "comment.llm-tell", "comment.stale-ref", "comment.stale-param"] }
   }
   ```

   `todo.codes` replaces the pack's fixable list for this project — the campaign is the queue.
   Restore or remove it when the campaign ends.

2. **Add the tools to the suite whose novelty is `baseline`** (`push` in the default suites), at
   `warn`: `<pack>/comments/long`, `<pack>/comments/llm-tells`, `<pack>/comments/stale-refs`. One
   baseline file serves the whole root and recording rewrites it from scratch, so join the suite
   that owns it — a second baseline-novelty suite would clobber the first's entries.

3. **Look before recording.** `static-x check push --project . --format text` shows everything the
   baseline is about to accept, including regressions in tools already gated. Then
   `static-x baseline push --project .`, once. Never again during the loop.

4. **Commit the setup by itself** — config plus baseline, no rewrites. This is the commit a
   reviewer argues with.

## The loop — one file per iteration, one commit per iteration

```sh
static-x todo push --project . --limit 8 --format json   # 1. the next file's worth
                                                         # 2. rewrite each block (below)
                                                         # 3. verify (below)
static-x ratchet push --project . --apply                # 4. bank it — the baseline shrinks
git commit                                               # 5. one file, one commit
```

### How to rewrite a block

A rewrite keeps the why and deletes the what. Read the block and the code it sits on, then write
one fresh line holding only what the code cannot say — the failure prevented, the measurement
behind a constant, the reason the obvious alternative is wrong. Never truncate: the budget is met
by compression, not by cutting the block off at line one.

- A block that only restates the code is deleted, not shortened. Deletion is the common case and a
  success.
- Doc comments get the same budget — one summary line, keeping only the non-obvious. Structured
  parameter and return sections do not survive a one-line budget; the human chose that when they
  set `maxLines`. If they want documentation exempt, that is a threshold change, not a rewrite
  question — stop and ask.
- Fix `comment.stale-ref`, `comment.stale-param`, and `comment.llm-tell` findings in the same pass
  — you are already holding the comment. And a compressing rewrite is exactly how a symbol name
  gets garbled into a new stale ref, so re-run `<pack>/comments/stale-refs` on the file after.
- Directives (`MARK:`, `TODO:`, linter pragmas) and license headers are already exempt — the tool
  never reports them, so never touch them.
- A block that is genuinely irreducible — an ASCII diagram, a table, quoted legal text — is what
  `ignore` is for: add its `data.name` to `<pack>.comments.long.ignore` and say why in the commit
  body. An `ignore` entry is a claim the policy is wrong once; it is not a place to hide work.

### Verification — the diff is the guard

No pack's typecheck can vouch for a prose edit, and the Swift pack has no compile guard at all. Two
checks stand in:

- **Every changed line in the diff must be a comment line.** A rewrite that touched a code line is
  reverted, not repaired.
- **The project's own proof runs**, when it has one: `swift build`/`swift test`, `npm run
  typecheck` and the test suite, whatever the root defines. Comments cannot change behaviour, so
  any failure means the diff clipped code — revert.

Then `ratchet --apply`. If it refuses because something regressed, you broke it — fix or revert.
Re-baselining would launder the regression into the record, which is the one failure this design
exists to prevent.

## Terminal state

`static-x todo` exits 0 when the queue is empty. One last `static-x ratchet push --apply` retires
the baseline and promotes what now reports nothing to `block` — from then on the gate holds every
new comment to the budget with no baseline to maintain. Remove the `todo.codes` override, commit,
and report the campaign closed.

## Reporting and stopping

After each iteration say: the file, blocks rewritten vs deleted vs ignored vs left, and the
baseline count before and after — `ratchet` prints the last one. Stop and report if the same block
survives two rewrite attempts, if build or tests fail in a way you did not cause, or if the queue
is dominated by doc comments and the human has not confirmed docs are in scope.

Xcode projects without a `buildServer.json` sweep 35–70× slower per file, and `ratchet` re-runs the
whole suite each iteration. Batch more files per iteration there, or set up `xcode-build-server`
first.
