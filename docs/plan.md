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
    config/                 #   static-x.json: default input, ignore/severity filters
    files/                  #   changed-file scopes: path resolution, finding filter
  ts/                       # TypeScript language pack
    server/                 #   spawn/attach typescript-language-server; lifecycle
    project/                #   bind to a project: tsconfig discovery, ts.Program,
    #                           file enumeration, incremental re-parse;
    #                           test-files.ts: shared *.test/*.spec detection
    ferry/                  #   maps tool invocations -> LSP requests / compiler
    #                           API calls against an open project session
    ast/                    #   shared AST helpers; targets.ts resolves a symbol
    #                           or position without a caret; structural.ts is
    #                           node identity (shape vs. tokens); hierarchy.ts
    #                           indexes inheritance in reverse; truncate.ts
    #                           flattens finding names for ignore lists
    comments/               #   comment analysis tools (compiler-API-backed)
      long/                 #   comments exceeding line/char thresholds
      stale-refs/           #   comments referencing symbols that don't resolve
      llm-tells/            #   comments with LLM-flavored language
    graph/                  #   import-graph.ts: resolved module graph, shared by
      dead-exports/         #   exports nothing imports, files nothing references
      cycles/               #   import cycles as strongly-connected components
    dupes/
      functions/            #   structurally identical function bodies (AST hash)
    types/
      loopholes/            #   assertions, non-null !, explicit any, directives
    async/
      floating-promises/    #   thenables dropped without await/.catch/void
    refactors/              #   guard.ts (in-memory typecheck), references.ts
    #                           (reference classifier), refactor-action.ts
    #                           (TypeScript's own refactoring engine),
    #                           text-changes.ts, output.ts, testing.ts
      rename/               #   symbol rename via LSP textDocument/rename
      move-symbol/          #   a declaration into another file, imports rewired
      move-file/            #   a file, with every specifier that resolves to it
      safe-delete/          #   a declaration nothing references, plus orphans
      inline-parameter/     #   a parameter every caller passes the same value for
      make-readonly/        #   readonly on a property nothing writes
  cli/                      # `sx <lang> <tool>` entrypoint, JSON output
  mcp/                      # MCP server exposing the same tool registry
  hooks/                    # example git and Claude Code hooks over the CLI
  fixtures/                 # sample projects used by tests: basic-ts, rename-ts,
  #                           graph-ts, dupes-ts, loopholes-ts, async-ts
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
- **WorkspaceEdit** — LSP's own edit format, plus `fileOps` for the changes text edits cannot express: creating, renaming, and deleting files. `changes` keys name paths in the post-`fileOps` tree, and `applyWorkspaceEdit` orders renames before content and deletions last. Analysis and mutation never mix in one tool.

Refactorings return a further shared envelope, `{ applied, edit, filesChanged, newDiagnostics, warnings }`. The two failure fields divide the two ways a refactoring can be wrong: `newDiagnostics` is what the in-memory typecheck *proves* the edit would break, and non-empty always blocks the apply; `warnings` is what that typecheck structurally cannot see — a reference through a string key, a path in `package.json`, a guarantee the language erases — where the edit is applied and the caller is told what was not checked. A tool that only had the first field would present a green typecheck as proof of safety, which for deletions and moves it is not.

### Project session (`ts/project`)

The stateful object every tool runs against:

- Locates `tsconfig.json` from a root path (explicit override supported; multi-tsconfig repos pick nearest-ancestor per file).
- Serves the compiler view from a `ts.LanguageService` rather than a bare `ts.Program`, because references, applicable refactorings, edits for a refactoring or a file rename, and code fixes are only indexed there. The program is the service's program, so a symbol resolved through the checker and a reference found through the service belong to one graph. Its host reads through an overlay, which is how an edit is typechecked before it touches disk.
- Distinguishes the corpus a tool *analyzes* from the files it *reports* in: `sourceFiles()`/`projectFiles()` are the whole project, `targetFiles()` is the caller's file scope when one is set. Scoping is a reporting filter by construction, so a run over one changed file resolves its comments, imports, and duplicates against everything else.
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

Both adapters take `files`, a list of paths to report findings in, reserved at the ferry rather than declared per tool. That is the contract an automated gate needs: a git hook has the staged list, a Claude Code `PostToolUse` hook has `tool_input.file_path`, and either becomes a check that costs one file's worth of findings without giving up project-wide resolution. `hooks/` ships working examples of both, plus the `--format text` output they print when they reject a change.

## Milestones (all complete)

1. ✅ **Scaffold** — package.json, tsconfig, vitest, lint; `core/tool` interfaces; empty registry; one fixture project under `fixtures/basic-ts/`.
2. ✅ **TS runtime** — `ts/server` spawn + handshake, `core/lsp` client, `ts/project` session with both views, `ts/ferry` dispatch. Proven by an integration test that opens the fixture and gets hover/definition through LSP.
3. ✅ **First analysis tool** — `ts/comments/long` end-to-end through the ferry and CLI. Smallest tool; validates the whole pipeline.
4. ✅ **Rename** — `ts/refactors/rename` with dry-run and apply modes, collision guard, tests covering cross-file renames and shorthand-property edge cases.
5. ✅ **Semantic comments** — `ts/comments/stale-refs` (symbol index, extractors, resolution tiers), then `ts/comments/llm-tells` with its pattern data file.
6. ✅ **MCP adapter** — expose the registry, session caching, README with Claude Code registration instructions.
7. ✅ **Data-validated analysis suite** — `ts/graph/dead-exports` + `ts/graph/cycles` on a shared import graph, `ts/dupes/functions`, `ts/types/loopholes`, `ts/async/floating-promises`. Each was prototyped as a probe against real corpora before hardening; the measured finding counts set the defaults — test-scaffold exclusion, entry-point exemptions, thenable-name `ignore` config.
8. ✅ **The refactoring foundation and the first five** — [ROADMAP.md](../ROADMAP.md) translates ReSharper's whole 61-entry refactoring index into TypeScript; the machinery it needs (language-service view, typecheck guard, reference classifier, refactor-engine wrapper, file operations on `WorkspaceEdit`, symbol targeting) landed with tests before any tool used it, and then `move-symbol`, `safe-delete`, `move-file`, `inline-parameter`, and `make-readonly` were built on it. Each behavior the tools rely on was measured against the vendored TypeScript before being coded against, not assumed.

Each milestone lands with tests against fixture projects — fixtures include deliberately stale comments, LLM-flavored comments, and rename edge cases, so tool quality is measured, not assumed.

## Later

- Second language pack (`py/` via pyright or `rust/` via rust-analyzer) to pressure-test how much of `core/` is truly language-agnostic.
- More comment tools: commented-out-code detection (try parsing comment bodies as TS), doc/signature drift (`@param` types vs. actual types). Probes over two real corpora found zero commented-out-code findings — deprioritized on that evidence.
- More refactors, in the order [ROADMAP.md](../ROADMAP.md#the-next-five) argues for: the extract family once a selection can be addressed by its text rather than its offsets, then the options-object half of `change-signature`, then the inline family — which needs a substitution checker before it is safe, since TypeScript's own inline-variable is silently wrong in three ways the guard cannot see.
- Watch mode: keep sessions warm and re-emit findings on file change.
