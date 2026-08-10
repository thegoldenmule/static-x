# static-x

Source-code tools for LLMs, built on language servers and static analysis instead of text search. Every tool answers questions through symbol tables, ASTs, or LSP capabilities — precise, resolved answers rather than grep output.

Each language has its own directory containing the machinery to run its language server, bind to a project on disk, and ferry tool calls, plus the tools themselves.

- **[TypeScript tools](ts/README.md)** — the available tools and what they do
- **[MCP server](mcp/README.md)** — expose the tools to Claude Code and other MCP clients
- **[Project plan](docs/plan.md)** — architecture, tool contracts, and milestones

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

static-x ts/comments/stale-refs --project .
static-x ts/comments/long --project . --input '{"maxLines": 20}'
static-x ts/comments/llm-tells --project .
static-x ts/async/floating-promises --project .
static-x ts/dupes/functions --project .
static-x ts/graph/cycles --project .
static-x ts/graph/dead-exports --project .
static-x ts/types/loopholes --project . --input '{"includeTests": false}'
static-x ts/refactors/rename --project . \
  --input '{"symbol": "makeOptions", "newName": "buildOptions"}'          # dry-run
static-x ts/refactors/rename --project . \
  --input '{"symbol": "makeOptions", "newName": "buildOptions", "apply": true}'
```

Usage is `static-x <tool> --project <root> [--input '<json>']`. Running with no arguments lists the available tools. Output is JSON on stdout — findings for analysis tools, a `WorkspaceEdit` plus status for refactors — so results pipe cleanly into `jq` or an LLM. Exit codes: `0` clean, `1` findings reported, `2` usage or execution error.

Each tool's README ([table here](ts/README.md)) documents its options, output shape, and what its findings mean. To use the tools from Claude Code conversationally, register the [MCP server](mcp/README.md).

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
