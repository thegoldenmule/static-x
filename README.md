# static-x

Source-code tools for LLMs, built on language servers and static analysis instead of text search. Every tool answers questions through symbol tables, ASTs, or LSP capabilities — precise, resolved answers rather than grep output.

Each language has its own directory containing the machinery to run its language server, bind to a project on disk, and ferry tool calls, plus the tools themselves.

- **[TypeScript tools](ts/README.md)** — the available tools and what they do
- **[MCP server](mcp/README.md)** — expose the tools to Claude Code and other MCP clients
- **[Hooks](hooks/README.md)** — `static-x install`: gate commits, pushes, and Claude's edits on the tools
- **[Project plan](docs/plan.md)** — architecture, tool contracts, and milestones
- **[Refactoring roadmap](ROADMAP.md)** — ReSharper's whole refactoring index, translated to TypeScript

## Install

Requires Node 20+. There is no build step — the CLI runs the TypeScript sources directly, so there is nothing to compile after installing.

**In a project** (recommended — the version is pinned in your lockfile, and the git hooks find the binary in `node_modules/.bin` without needing anything on `PATH`):

```sh
cd ~/code/my-app
npm install --save-dev github:thegoldenmule/static-x
npx static-x --help
```

**Globally**, to run it against any project without adding a dependency:

```sh
npm install -g github:thegoldenmule/static-x
static-x --help
```

**From a clone**, to work on static-x itself:

```sh
git clone https://github.com/thegoldenmule/static-x.git
cd static-x && npm install
npm link                       # puts `static-x` and `static-x-mcp` on your PATH
npm run sx -- --help           # or run it in place, without linking
```

Either of the first two puts two binaries in place: `static-x` (the CLI) and `static-x-mcp` (the [MCP server](mcp/README.md)). Project-local installs reach them through `npx static-x`, or directly as `./node_modules/.bin/static-x`.

## Turn on the checks

Three commands take a project from nothing to a gate that rejects a bad commit. Run them in order, from the project root:

```sh
npx static-x install         # 1. write the hooks and the default suites
npx static-x baseline        # 2. record what's already there, so it doesn't block you
npx static-x check commit    # 3. see what a commit would be judged on
```

What each one does:

1. **`install`** writes a `pre-commit` and `pre-push` hook (into `.husky/` if you use husky, `.git/hooks/` otherwise), registers the Claude Code `PostToolUse` hook in `.claude/settings.json`, and copies the default check suites into `static-x.json` so you can read and edit them. It never overwrites a hook it didn't write. Add `--dry-run` to see the file list first.

2. **`baseline`** records every finding the push suite reports right now into `static-x-baseline.json`. **Do this before your first push**, or the push hook reports your whole backlog at once. Commit the file — later runs report only what came after it. It tells you if it just accepted anything that would otherwise block.

3. **`check commit`** runs what the pre-commit hook runs. Nothing staged means nothing to report, so stage something first if you want to see it work.

Then commit as normal. A dropped promise in the lines you just wrote stops the commit:

```
Blocking (1):
  src/bad.ts:2:31  warning  async.floating-promise  This statement creates a Promise and drops it: ...

commit: reporting changed-lines
```

The same defect in a file you didn't touch stays silent — the commit suite reports on changed lines, which is what makes it installable on a codebase that has never had a gate. `--no-verify` bypasses it once. `static-x check --list` shows every suite and what it enforces; [hooks](hooks/README.md) explains how to change them, how `static-x todo` turns the baseline back into a work queue, and how `static-x ratchet` tightens the gates as you spend that queue down.

To take it all back out: delete `.husky/pre-commit` and `.husky/pre-push` (or the same files under `.git/hooks/`), the `hooks.PostToolUse` entry in `.claude/settings.json`, and `static-x.json` / `static-x-baseline.json`.

## Use on a project

Point any tool at a TypeScript project — a directory containing (or whose subtree contains) a `tsconfig.json`:

```sh
cd ~/code/my-app

static-x ts/async/floating-promises --project .
static-x ts/comments/llm-tells --project .
static-x ts/comments/long --project . --input '{"maxLines": 20}'
static-x ts/comments/stale-refs --project .
static-x ts/dupes/functions --project .
static-x ts/graph/cycles --project .
static-x ts/graph/dead-exports --project .
static-x ts/refactors/change-signature --project . --input '{"symbol": "makeOptions"}'
static-x ts/refactors/extract --project . \
  --input '{"file": "src/cart.ts", "select": "line.qty * line.unit"}'   # list scopes
static-x ts/refactors/extract-type --project . \
  --input '{"file": "src/net.ts", "select": "{ host: string; port: number }", "name": "Endpoint"}'
static-x ts/refactors/inline-function --project . --input '{"symbol": "difference"}'
static-x ts/refactors/inline-parameter --project . \
  --input '{"symbol": "log", "parameter": "level"}'
static-x ts/refactors/make-readonly --project . --input '{"symbol": "limit"}'
static-x ts/refactors/module-form --project . \
  --input '{"file": "src/greet.ts", "symbol": "greet", "to": "named-export"}'
static-x ts/refactors/move-file --project . \
  --input '{"file": "src/lib.ts", "toDirectory": "src/core"}'
static-x ts/refactors/move-symbol --project . \
  --input '{"symbol": "Shipment", "toFile": "src/models.ts"}'
static-x ts/refactors/rename --project . \
  --input '{"symbol": "makeOptions", "newName": "buildOptions"}'          # dry-run
static-x ts/refactors/rename --project . \
  --input '{"symbol": "makeOptions", "newName": "buildOptions", "apply": true}'
static-x ts/refactors/safe-delete --project . --input '{"symbol": "formatLabel"}'
static-x ts/types/loopholes --project . --input '{"includeTests": false}'
```

Usage is `static-x <tool> --project <root> [--input '<json>'] [--files <path>]... [--files-from <file|->] [--format json|text]`. Running with no arguments lists the available tools. Output is JSON on stdout — findings for analysis tools, a `WorkspaceEdit` plus status for refactors — so results pipe cleanly into `jq` or an LLM. Exit codes: `0` clean, `1` findings reported, `2` usage or execution error.

Five subcommands sit alongside the tools, named without a slash so they can never collide with one: `check <suite>` runs a named group of tools over a single project session, `baseline` records what a suite reports now, `todo` lists what that baseline is hiding as a work queue, `ratchet` tightens the gates as far as the project already allows, and `install` writes the hooks that call them — see [hooks](hooks/README.md).

Each tool's README ([table here](ts/README.md)) documents its options, output shape, and what its findings mean. To use the tools from Claude Code conversationally, register the [MCP server](mcp/README.md).

## Check only what changed

Every analysis tool takes a list of files to report on — the changed-files list a hook has on hand:

```sh
static-x ts/types/loopholes --project . --files src/api.ts --files src/db.ts
static-x ts/comments/long --project . --files src/components      # directories included
git diff --cached --name-only -z | static-x ts/comments/long --project . --files-from -
```

A file list narrows what is *reported*, never what is *analyzed*. Symbol indexes, import graphs, and duplicate groups still span the whole project — that is what keeps the answers true, since a comment names symbols declared elsewhere and a cycle you just created runs through files you didn't touch. A scoped run says exactly what a full run says about those files, and stays silent about the rest.

The list is deliberately forgiving, so raw `git` output pipes in unfiltered: paths may be project-relative, working-directory-relative, or absolute; paths naming no source file are ignored; a list with no source files at all (a docs-only commit) is answered without loading the project. `--format text` prints one `file:line:column  severity  code  message` line per finding, for hooks and humans; `ts/refactors/rename` refuses `--files`, since a partial file list would mean a partial refactor.

`static-x install` wires this into git `pre-commit`/`pre-push` and Claude Code's `PostToolUse` — with one difference that matters. A hook built on `--files` alone reports everything the touched files already had: 79 of this repository's 141 source files carry a finding, so such a hook rejects most commits over code their author never wrote. A [check suite](hooks/README.md) adds the missing half, reporting only what the change introduced.

## Configuration

Put a `static-x.json` in the analyzed project's root (the `--project` directory, not this repo). Its schema mirrors the tool paths, and it applies identically through the CLI and MCP:

```json
{
  "ts": {
    "comments": {
      "stale-refs": {
        "input": { "extraRoots": ["../sibling-package"] },
        "ignore": ["ts_rank", "websearch_to_tsquery"],
        "minConfidence": "medium"
      },
      "long": { "input": { "maxLines": 20 } }
    },
    "async": {
      "floating-promises": { "ignore": ["FastifyReply"] }
    }
  }
}
```

Per tool node:

| Key | Meaning |
| --- | --- |
| `input` | Default tool input; fields passed explicitly via `--input` win |
| `ignore` | Drop findings whose `data.name` matches exactly — the escape hatch for project-specific false positives (SQL identifiers in comments, spec notation, external tool names) |
| `minSeverity` | Drop findings below `info` < `warning` < `error` |
| `minConfidence` | Drop findings whose `data.confidence` is below `low` < `medium` < `high` (findings without a confidence pass) |

(`files` is not a config key — it names one run's changed files, so it belongs on the command line or in the MCP call, not in a file checked into the project.)

A top-level `checks` block sits beside `ts`, naming which tools gate which event and how hard. That is deliberately the same file: selection in shell environment variables and tuning in a config file meant neither half told you what the gate actually did. See [hooks](hooks/README.md).
