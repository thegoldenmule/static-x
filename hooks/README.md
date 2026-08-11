# Hooks

```sh
static-x install
```

That writes a pre-commit and a pre-push hook (into `.husky/` if the project uses husky, `.git/hooks/` otherwise), registers the Claude Code `PostToolUse` hook, and copies the default check suites into `static-x.json` where you can read and edit them. `--dry-run` shows what it would touch; `--target git|claude|config` narrows it.

The scripts it writes hold no policy at all:

```sh
exec "$bin" check commit --from git-staged
```

Everything the gate does lives in `static-x.json`. Changing what a hook enforces never means editing a shell script or remembering which environment variable configured it.

## The suites

`static-x check --list` prints them. The defaults:

| Suite | Event | Reports | Blocks on |
| --- | --- | --- | --- |
| `commit` | pre-commit | lines this change added | `async/floating-promises`, `graph/cycles` |
| `push` | pre-push | what isn't in the baseline | `graph/cycles` |
| `claude` | `PostToolUse` | the file Claude just wrote | `async/floating-promises`, `types/loopholes` |

Each also runs tools at `warn`, which report without rejecting — comment length, duplicate functions, LLM tells, stale references, dead exports.

The block/warn split is measured rather than chosen. Of the eight analysis tools, only `async/floating-promises` and `graph/cycles` report nothing against this repository; those two find defects, so they block. Everything else finds things that are true, worth knowing, and a matter of degree. A gate that blocks on taste is one people learn to pass with `--no-verify`, and then it is worth nothing on the day it catches a dropped promise.

To change a gate, edit the suite:

```json
{
  "checks": {
    "commit": {
      "novelty": "changed-lines",
      "tools": {
        "ts/async/floating-promises": "block",
        "ts/dupes/functions": { "level": "block", "minSeverity": "warning" },
        "ts/comments/long": "warn",
        "ts/comments/llm-tells": "off"
      }
    }
  }
}
```

A tool is `block`, `warn`, or `off`. The long form carries the same tuning keys as a [tool config](../README.md#configuration) — `ignore`, `minSeverity`, `minConfidence`, `input` — applied on top of whatever that tool already reads, so a gate can be stricter than the tool's everyday settings without changing them everywhere. A suite you write replaces the default of that name outright; suites you leave alone keep theirs. Naming a refactoring is an error: it rewrites code and cannot be scoped to a changed-file list, so it cannot gate an event.

## Novelty: the reason this is installable

Run the commit suite unfiltered against this repository and **79 of 141 source files carry a finding**. A hook that reported all of them would reject the majority of commits over code the author never wrote, and it would be uninstalled the same afternoon. `novelty` is what decides which findings a change is answerable for.

| Value | Reports |
| --- | --- |
| `changed-lines` | Findings overlapping a line the change added. No state, correct on day one. |
| `changed-file` | Every finding in a touched file, however old. |
| `baseline` | Everything absent from `static-x-baseline.json`. |
| `none` | Everything. |

They are not interchangeable, and which one is right depends on where a tool anchors its finding. `comments/long`, `types/loopholes`, `async/floating-promises` and `dupes/functions` all anchor on the offending code, so `changed-lines` works: add a duplicate function and the finding lands in your hunk. `graph/cycles` anchors on one representative file of the cycle and `graph/dead-exports` reports in the file that *declares* the export — delete the last import of something in `a.ts` and the finding appears in `b.ts`. Neither has a line you touched, which is why the push suite uses a baseline instead.

```sh
static-x baseline          # records the push suite as it stands now
```

Commit the file. Later runs report only what came after. It names anything it just accepted at `block` level — a baseline is the one command that can lose you a real finding, so it does not do that quietly. It is meant to shrink: every entry is a finding someone decided not to fix yet, and re-running rewrites it from scratch, so an entry that no longer reproduces disappears rather than lingering as a permanent excuse.

A policy the event cannot supply the inputs for degrades to the next broader one and says so. Silence there would be the dangerous option — a gate that quietly stopped filtering looks exactly like a gate that found something real.

## Ratcheting

```sh
static-x ratchet             # what could be tightened
static-x ratchet --apply     # tighten it
```

`baseline` accepts whatever it finds; `ratchet` only ever tightens. That split is the whole design. Accepting is what lets you turn a gate on for a codebase that has never had one, and it is exactly the wrong behavior for banking progress — run `baseline` after a regression and you have recorded the regression.

Three things it tightens, each provable from the project's own findings rather than from a policy someone has to keep current:

- **The baseline shrinks** to what still reproduces. Every entry it drops is something you fixed.
- **A `warn` tool becomes `block`** once it reports nothing at all. Not once it reports nothing *new* — a tool whose findings are merely baselined looks clean while the baseline holds, and the next deliberate re-record would turn all of them into blocking findings at once.
- **The baseline policy retires** once the baseline empties: `novelty` drops to `none` and the file is deleted. There is nothing left to grandfather.

```
push: baseline 327 → 326 (1 entry resolved)
  cli/format.ts|graph.dead-export|summary  gone
```

A regression refuses the whole run, banking nothing:

```
push: 1 finding regressed since the baseline was recorded — fix them, or
      accept them deliberately with `static-x baseline`
  cli/format.ts|graph.dead-export|RATCHET_PROBE  0 → 1
```

Ten fixes and one regression is still a refusal. Writing a baseline that accommodates the regression is what the other command is for.

It is dry-run by default, like every mutating tool here, and **not a hook and not a CI step**. A ratchet that runs automatically locks in whatever strictness one machine reached on a good day, and the next person to push is blocked by someone else's luck. Run it when you want to bank progress.

## Working the backlog down

A baseline is a debt register. `static-x todo` is how you spend it down:

```sh
static-x todo                    # what the baseline is hiding, grouped by file
static-x todo --limit 8          # the next file's worth
static-x todo --format json      # with data.name, for an ignore entry
```

It lists the findings the baseline accounts for — the opposite question to `check`, which reports only what is new. Files with the most findings come first, because one edit and one test run is the cheapest unit of progress available.

**It is restricted by default to codes whose fix a typecheck and a test run can actually vouch for**: `async.floating-promise`, `comment.stale-ref`, `comment.stale-param`, `dupes.function`. Everything else is reported as held back rather than offered as work, and the reasons differ. Deleting a dead export may remove API something outside the project imports, which the tool says in its own message and no test suite here would catch. Comment-length thresholds are taste, and an agent shortening comments to satisfy a number makes the code worse. Removing a type assertion means proving the type, and the cheap fix hides the hole rather than closing it. `--all` drops the restriction for a human deciding; `todo.codes` in `static-x.json` replaces the list for a project that disagrees.

### The loop

`static-x install` writes a Claude Code skill, [`static-x-backlog`](../.claude/skills/static-x-backlog/SKILL.md), that drives this:

```sh
static-x todo --limit 8                               # take the next file
                                                      # decide each item
npm run typecheck && npm run lint && npx vitest run    # prove nothing broke
static-x ratchet --apply                              # bank it — baseline shrinks
git commit                                            # one file, one commit
```

Every finding gets one of three answers, and **fixing is not the default**:

- **Fix it** — the finding is right and the correct change is clear.
- **Ignore it** — the finding is wrong. Record the exact `data.name` under that tool's `ignore` in `static-x.json`. This is a real answer: `comment.stale-ref` cannot tell a stale reference from a correct one naming something outside the project, so a comment citing a compiler API or a SQL function is flagged and is not a defect.
- **Leave it** — you are not sure, or the fix is a design decision. A wrong fix costs more than an unfixed finding.

The one rule that matters: **never run `static-x baseline` inside the loop.** If `ratchet` refuses because something regressed, something broke — fix it or revert it. Re-baselining would launder the regression into the record, which is the single failure this whole design exists to prevent.

That is not hypothetical. The first real iteration in this repository went: four `comment.stale-ref` findings at the head of the queue, all naming genuine TypeScript compiler APIs (`createArrayTypeNode`, `parenthesizeNonArrayTypeOfPostfixType` — checked against `typescript.js`), so all four were `ignore`. Then `ratchet` **refused**, because unrelated work in the same session had exported two types nothing imported. Fixing those and re-running took the baseline from 327 to 323.

## Exit codes

`check` follows the CLI's: **0** clean (advisory findings included), **1** blocked, **2** could not run. A git hook rejects on 1 and lets 2 through, so a project mid-refactor can never leave you unable to commit.

`--from claude` swaps in Claude Code's contract instead, which is why its hook no longer needs a wrapper script: **2** blocks the edit and feeds stderr back to the model, and everything else is 0. Every failure under that flag becomes 0 deliberately — static-x's own "could not run" is also 2, and a hook that wedges the session is worse than no hook.

## Cost

One `check` runs the whole suite over one project session, so the language server starts and the program typechecks once rather than once per tool. Against this repository:

| | wall |
| --- | --- |
| five tools, five CLI processes | 5.9s |
| five tools, one `check` | 0.93s |
| — the first tool, paying project load | 440ms |
| — each tool after | 48–322ms |

A commit whose staged files contain no source at all costs nothing: dispatch answers a scope naming no source file before opening a session, so a docs-only commit never pays for a typecheck.

Two things worth weighing before turning the Claude hook on. It runs on **every** edit, and while sub-second here it is not free on a large project — running the checks on `Stop` instead costs one pass per turn. And the [MCP server](../mcp/README.md) keeps a session warm across calls, which lets Claude scope a check itself rather than paying startup per hook invocation.

## Doing it by hand

The files here are exactly what the installer writes, asserted by [`hooks.test.ts`](hooks.test.ts) so the two cannot drift:

| File | Event |
| --- | --- |
| [`git/pre-commit`](git/pre-commit) | git `pre-commit` |
| [`git/pre-push`](git/pre-push) | git `pre-push` |
| [`claude/settings.example.json`](claude/settings.example.json) | the `.claude/settings.json` block |

Both git hooks read the working tree, not the index, so a partially staged file is judged by what is on disk while being *attributed* by what was staged. Wrap the checks in `git stash push --keep-index` / `git stash pop` if that matters; the installer does not, because a working-tree rewrite on every commit fails badly when interrupted.
