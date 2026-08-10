# TypeScript tools

Tools that operate on TypeScript projects through a shared [project session](project/session.ts) holding two views: a running `typescript-language-server` (LSP view) and a `ts.Program` with its type checker (compiler view).

| Tool | Description |
| --- | --- |
| [`ts/comments/long`](comments/long/README.md) | Flags comment blocks that exceed line or character thresholds, using the parsed AST so string contents can never masquerade as comments. |
| [`ts/comments/stale-refs`](comments/stale-refs/README.md) | Finds comments referencing code that doesn't exist, by resolving JSDoc tags, code spans, and identifier-shaped prose against the symbol table. |
| [`ts/comments/llm-tells`](comments/llm-tells/README.md) | Scores comments for LLM-generated hallmarks — filler phrasing, change-log prose, and narration that restates the next line. |
| [`ts/graph/cycles`](graph/cycles/README.md) | Finds import cycles as strongly-connected components of the resolved module graph — one finding per cycle group, with cycles made only of `import type` edges downgraded to info. |
| [`ts/graph/dead-exports`](graph/dead-exports/README.md) | Finds exports nothing imports and files nothing references, by resolving every import edge — tsconfig path aliases included — into a project-wide module graph. |
| [`ts/refactors/rename`](refactors/rename/README.md) | Renames a symbol project-wide via the language server, dry-run by default, refusing renames that would introduce compile errors. |

## Layout

- `server/` — spawns `typescript-language-server` and completes the LSP handshake
- `project/` — binds to a project on disk; owns the LSP and compiler views
- `ferry/` — dispatches tool calls, caching one session per project root
- `comments/`, `graph/`, `refactors/` — the tools
- `registry.ts` — registers every shipped tool for the CLI and MCP adapters
