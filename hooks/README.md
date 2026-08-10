# Example hooks

Working hooks that run static-x automatically — on commit, on push, and after Claude Code edits a file. Copy one, point it at the tools you care about, and it becomes a gate that rejects code before anyone reviews it.

| File | Event | What it does |
| --- | --- | --- |
| [`git/pre-commit`](git/pre-commit) | git `pre-commit` | Runs per-file tools over the staged files; blocks the commit on findings |
| [`git/pre-push`](git/pre-push) | git `pre-push` | Runs whole-project tools (import cycles by default); blocks the push on findings |
| [`claude/reject-long-comments.mjs`](claude/reject-long-comments.mjs) | Claude Code `PostToolUse` | Checks the file Claude just wrote and hands findings back to the model to fix |
| [`claude/settings.example.json`](claude/settings.example.json) | — | The `.claude/settings.json` block that registers the hook above |

All four are configured by environment variables (`STATIC_X_TOOLS`, `STATIC_X_PROJECT`, `STATIC_X_BIN`) so the same script serves any tool combination. Thresholds, ignores, and severity floors belong in the project's `static-x.json`, which the CLI honors identically — see the [configuration table](../README.md#configuration).

## The mechanism: `--files`

Hooks know which files changed. Every analysis tool takes that list:

```sh
git diff --cached --name-only -z | static-x ts/comments/long --project . --files-from - --format text
static-x ts/types/loopholes --project . --files src/api.ts --files src/db.ts
```

What a file list narrows is **what gets reported**, not what gets analyzed. The symbol index, the import graph, and the duplicate groups still cover the whole project, because that is the only way the answers stay true: a comment in the changed file names symbols declared in files you didn't touch, and an import cycle you just created runs through files that haven't changed since last year. So a scoped run says exactly what a full run says about those files — it just doesn't mention the rest.

That has a consequence worth knowing when you pick tools per event. A cycle is reported if the changed file is anywhere in it, and a duplicate is reported with its peers wherever they live, but `ts/graph/dead-exports` reports an export as dead in the file that *declares* it. Delete the last import of something in `a.ts` and the finding lands in `b.ts` — which a commit-scoped run won't show you. That's why `pre-push` runs the graph tools unscoped.

Practical details the scripts rely on:

- **Paths can be relative to the project root, relative to the working directory, or absolute** — a hook running at a repo root against `--project packages/app` works without translating anything.
- **Paths that name no source file are ignored**, so a raw `git diff --name-only` list (deleted files, markdown, lockfiles) can be piped in unfiltered.
- **A list with no source files at all costs nothing**: static-x answers with no findings without loading the project, so a docs-only commit doesn't pay for a typecheck.
- **Directories match everything beneath them** (`--files src/components`).
- **A path the project's `tsconfig.json` doesn't include is ignored like any other non-source path.** If a scoped run says nothing about a file you expected findings in, check that the tsconfig actually covers it.
- `ts/refactors/rename` rejects `--files` rather than accepting it: a partial file list would mean a partial refactor, which is a broken program.

## Git hooks

```sh
cp hooks/git/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

With husky, copy into `.husky/` instead. To check more than comment length:

```sh
STATIC_X_TOOLS="ts/comments/long ts/types/loopholes ts/async/floating-promises" git commit
```

Exit codes drive the gate: static-x exits `1` when it reports findings (the hook blocks) and `2` when it could not run at all — no `tsconfig.json`, unparseable config. The scripts deliberately treat `2` as a warning and let the commit through, so a project mid-refactor can never leave you unable to commit. Findings print as `file:line:column  severity  code  message`, which terminals and editors turn into clickable locations.

Both scripts read the working tree, not the index, so a partially staged file is judged by what is on disk. If that matters, wrap the checks in `git stash push --keep-index` / `git stash pop`.

## Claude Code hooks

Copy the script and register it:

```sh
mkdir -p .claude/hooks
cp hooks/claude/reject-long-comments.mjs .claude/hooks/
```

Then merge [`settings.example.json`](claude/settings.example.json) into `.claude/settings.json` (project-wide) or `.claude/settings.local.json` (just you). The matcher `Edit|Write` fires the hook after any file write; the script reads the event JSON on stdin, pulls `tool_input.file_path`, and ignores anything that isn't a TypeScript file.

The exit codes there are Claude Code's, not static-x's: **exit 2 blocks and feeds stderr back to the model**, which is what turns a finding into a fix attempt. Everything else lets the edit stand. The script exits 0 when static-x is missing or fails, on the principle that a hook should never trap the session.

Two things to weigh before turning this on:

- **Cost.** Each invocation loads the project and typechecks it — sub-second on a small project, several seconds on a large one, paid on every edit. If that bites, run the checks on `Stop` (once per turn) instead of `PostToolUse`, or use the [MCP server](../mcp/README.md), which keeps the session warm across calls and lets Claude scope a check to changed files itself.
- **Blocking versus advising.** Comment length is a matter of taste, and a hook that blocks on taste turns into a fight the model always loses. Consider blocking only on the tools with real defects behind them — `ts/async/floating-promises` finds dropped promises, `ts/types/loopholes` finds discarded typechecking — and leaving the comment tools to `pre-commit`, where a human decides.
