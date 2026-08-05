# static-x — Plan

Tools for LLMs that operate on source code through language servers, symbol tables, and static analysis — not text search. An LLM asking "which comments reference symbols that no longer exist?" should get a precise, resolved answer, not grep output.

## Guiding principles

1. **Semantic, not lexical.** Every tool answers questions using symbol resolution, ASTs, or language-server capabilities. If a tool could be implemented with grep, it doesn't belong here.
2. **Tools are data-in, data-out.** Each tool takes a JSON input, returns JSON findings or edits. No interactive state leaks into tool contracts. This makes them equally usable from a CLI, an MCP server, or direct library calls.
3. **Language folders own their runtime.** Each language (`ts/`, later `py/`, `rust/`, …) contains everything needed to launch/attach to its language server, bind to a project on disk, and ferry tool calls. Shared plumbing (JSON-RPC, LSP client, tool registry) lives in `core/`.
4. **LSP where it's enough, compiler API where it isn't.** LSP gives us rename, references, definitions, diagnostics — portable across languages. But LSP has no concept of comments or raw ASTs. Tools that need those (all of `ts/comments/`) drop down to the TypeScript compiler API. Both run against the same project session so results stay consistent.

## Repository layout

```
static-x/
  docs/                     # this plan, per-tool design notes
  core/                     # language-agnostic plumbing
    rpc/                    #   JSON-RPC over stdio (vscode-jsonrpc)
    lsp/                    #   generic LSP client: initialize, doc sync, requests
    tool/                   #   Tool interface, registry, finding/edit schemas
  ts/                       # TypeScript language pack
    server/                 #   spawn/attach typescript-language-server; lifecycle
    project/                #   bind to a project: tsconfig discovery, ts.Program,
    #                           file enumeration, incremental re-parse
    ferry/                  #   maps tool invocations -> LSP requests / compiler
    #                           API calls against an open project session
    comments/               #   comment analysis tools (compiler-API-backed)
      long/                 #   comments exceeding line/char thresholds
      stale-refs/           #   comments referencing symbols that don't resolve
      llm-tells/            #   comments with LLM-flavored language
    refactors/
      rename/               #   symbol rename via LSP textDocument/rename
  cli/                      # `sx <lang> <tool>` entrypoint, JSON output
  mcp/                      # MCP server exposing the same tool registry
  fixtures/                 # small sample projects used by tests
```

Single Node/TypeScript package to start (`vitest` for tests, `tsx` for dev). Split into workspaces only if/when a second language pack lands.

## Core abstractions

### Tool contract (`core/tool`)

```ts
interface Tool<In, Out> {
  name: string;               // "ts/comments/stale-refs"
  description: string;        // written for LLM consumption
  inputSchema: JSONSchema;    // validated before run
  outputSchema: JSONSchema;
  run(session: ProjectSession, input: In): Promise<Out>;
}
```

Two canonical output shapes, so every tool composes with every consumer:

- **Finding** — `{ file, range: {start, end}, code, message, severity, data? }`. Ranges are 0-based line/character, matching LSP. `code` is machine-readable (`comment.stale-ref`), `data` carries tool-specific detail (e.g. the unresolved identifier).
- **WorkspaceEdit** — LSP's own edit format. Tools that change code return edits; a shared `applyEdits(session, edit, { dryRun })` performs writes. Analysis and mutation never mix in one tool.

### Project session (`ts/project`)

The stateful object every tool runs against:

- Locates `tsconfig.json` from a root path (explicit override supported; multi-tsconfig repos pick nearest-ancestor per file).
- Owns two views of the same project, created lazily:
  - **LSP view** — a running `typescript-language-server` initialized on the root, with document-sync bookkeeping (open/close/version tracking).
  - **Compiler view** — a `ts.Program` + `ts.TypeChecker` built from the tsconfig, for AST/comment/symbol-table work LSP can't do.
- Handles invalidation: if a tool applies edits, both views refresh before the next call.

### Server lifecycle (`ts/server`) and ferry (`ts/ferry`)

- `server/`: spawn `typescript-language-server --stdio` as a child process, handshake (`initialize`/`initialized`), health check, idle shutdown, and reconnect. Config allows attaching to an already-running server socket instead of spawning.
- `ferry/`: the dispatch layer. Given `(toolName, input)`, resolves the tool from the registry, ensures a session exists for the requested project root, runs the tool, and returns validated output. Sessions are cached per project root so repeated calls are cheap (no re-spawn, no re-typecheck unless files changed).

## The first tools

### `ts/comments/long`

Compiler-API-backed. Walk source files with `ts.getLeadingCommentRanges`/`getTrailingCommentRanges` (plus JSDoc nodes), merge adjacent single-line comments into blocks, flag blocks over configurable thresholds (default: 10 lines or 800 chars). Output: findings with the comment's range and measured size. Excludes license headers (top-of-file heuristic) and directive comments (`@ts-expect-error`, `eslint-disable`, `/// <reference>`).

### `ts/comments/stale-refs`

The flagship semantic tool. For each comment:

1. **Extract candidate references**: JSDoc tags (`@param name`, `@see X`, `{@link X}`), backtick-quoted code spans, and bare identifiers that look like code (CamelCase, snake_case, `foo.bar`, `foo()`).
2. **Resolve each candidate** against the symbol table via `ts.TypeChecker`, scoped by likelihood: names in scope at the comment's position → file-level declarations → project-wide exported symbols (prebuilt index).
3. **Flag what doesn't resolve.** `@param` names are checked against the actual parameter list (high confidence). Bare prose words get a conservative filter (must look like an identifier AND appear nowhere in the symbol index) to keep false positives down.

Output findings carry the unresolved name, extraction source (jsdoc-tag / code-span / bare), and a confidence level, so an LLM consumer can decide what to act on.

### `ts/comments/llm-tells`

Heuristic, but AST-scoped: it only examines real comment ranges, never string literals or code. A curated pattern list (data file, easy to extend) covering:

- Filler phrases: "It's worth noting", "Note that", "Additionally,", "In summary", "delve", "leverages", "seamlessly", "robust".
- Narration comments that restate the next line ("Increment the counter" above `counter++`) — detected by token overlap between comment and following statement.
- Change-log-style comments that describe the edit rather than the code ("Updated to handle X", "Fixed the bug where…", "Now uses Y instead of Z").

Each pattern has a weight; findings report matched patterns and a score. Ships with the list versioned in-repo so it can be tuned against real corpora.

### `ts/refactors/rename`

LSP-backed. Flow: `textDocument/prepareRename` at the target position (validates the symbol is renameable) → `textDocument/rename` with the new name → receive `WorkspaceEdit` covering all references project-wide → apply to disk (or return as dry-run). Input accepts either a position (`file`, `line`, `character`) or a symbol name + optional disambiguating file, resolved to a position via the compiler view. Guards: refuse if the new name collides in any affected scope (check via re-resolution after a dry-run apply), report the full set of touched files.

## Delivery to LLMs

Two thin adapters over the same registry:

- **CLI** (`cli/`): `sx ts/comments/stale-refs --project ./myapp --json`. Findings print as JSON lines; exit code reflects finding count. This is immediately usable from Claude Code's Bash tool.
- **MCP server** (`mcp/`): each registered tool becomes an MCP tool with its schemas passed through verbatim. Server holds the session cache, so an LLM conversation gets warm, incremental analysis across calls.

Tool descriptions and schemas are written for the LLM as the audience — they state what the tool checks, what a finding means, and what a sensible next action is.

## Milestones

1. **Scaffold** — package.json, tsconfig, vitest, lint; `core/tool` interfaces; empty registry; one fixture project under `fixtures/basic-ts/`.
2. **TS runtime** — `ts/server` spawn + handshake, `core/lsp` client, `ts/project` session with both views, `ts/ferry` dispatch. Proven by an integration test that opens the fixture and gets hover/definition through LSP.
3. **First analysis tool** — `ts/comments/long` end-to-end through the ferry and CLI. Smallest tool; validates the whole pipeline.
4. **Rename** — `ts/refactors/rename` with dry-run and apply modes, collision guard, tests covering cross-file renames and shorthand-property edge cases.
5. **Semantic comments** — `ts/comments/stale-refs` (symbol index, extractors, resolution tiers), then `ts/comments/llm-tells` with its pattern data file.
6. **MCP adapter** — expose the registry, session caching, README with Claude Code registration instructions.

Each milestone lands with tests against fixture projects — fixtures include deliberately stale comments, LLM-flavored comments, and rename edge cases, so tool quality is measured, not assumed.

## Later

- Second language pack (`py/` via pyright or `rust/` via rust-analyzer) to pressure-test how much of `core/` is truly language-agnostic.
- More comment tools: commented-out-code detection (try parsing comment bodies as TS), doc/signature drift (`@param` types vs. actual types).
- More refactors: extract-function, move-symbol, inline — all LSP/compiler-API-backed with the same WorkspaceEdit contract.
- Watch mode: keep sessions warm and re-emit findings on file change.
