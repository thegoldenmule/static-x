# static-x

Source-code tools for LLMs, built on language servers and static analysis instead of text search. Every tool answers questions through symbol tables, ASTs, or LSP capabilities — precise, resolved answers rather than grep output.

Each language has its own directory containing the machinery to run its language server, bind to a project on disk, and ferry tool calls, plus the tools themselves.

- **[TypeScript tools](ts/README.md)** — the available tools and what they do
- **[MCP server](mcp/README.md)** — expose the tools to Claude Code and other MCP clients
- **[Example hooks](hooks/README.md)** — run the tools on changed files from git and Claude Code hooks
- **[Project plan](docs/plan.md)** — architecture, tool contracts, and milestones
- **[Refactoring roadmap](ROADMAP.md)** — ReSharper's whole refactoring index, translated to TypeScript

## Install

Requires Node 20+. No build step — the CLI runs the TypeScript sources directly.

```sh
git clone https://github.com/thegoldenmule/static-x.git
cd static-x
npm install
npm link        # puts `static-x` and `static-x-mcp` on your PATH
```

(Without `npm link`, substitute `node /path/to/static-x/cli/sx.mjs` for `static-x` below.)

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
static-x ts/refactors/inline-parameter --project . \
  --input '{"symbol": "log", "parameter": "level"}'
static-x ts/refactors/make-readonly --project . --input '{"symbol": "limit"}'
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

Ready-made [example hooks](hooks/README.md) wire this into git `pre-commit`/`pre-push` and Claude Code's `PostToolUse`.

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
