# TypeScript tools

Tools that operate on TypeScript projects through a shared [project session](project/session.ts) holding two views: a running `typescript-language-server` (LSP view) and a `ts.Program` with its type checker (compiler view).

Tools are listed in the alphabetical order the CLI and MCP listings display.

| Tool | Description |
| --- | --- |
| [`ts/async/floating-promises`](async/floating-promises/README.md) | Flags statements that drop a thenable value — no await, no `.catch`, no `void` — via the type checker, so `Promise.all` and custom thenables like FastifyReply count, separable by type name. |
| [`ts/comments/llm-tells`](comments/llm-tells/README.md) | Scores comments for LLM-generated hallmarks — filler phrasing, change-log prose, and narration that restates the next line. |
| [`ts/comments/long`](comments/long/README.md) | Flags comment blocks that exceed line or character thresholds, using the parsed AST so string contents can never masquerade as comments. |
| [`ts/comments/stale-refs`](comments/stale-refs/README.md) | Finds comments referencing code that doesn't exist, by resolving JSDoc tags, code spans, and identifier-shaped prose against the symbol table. |
| [`ts/dupes/functions`](dupes/functions/README.md) | Finds structurally identical function bodies by hashing each body's AST shape — identifier names and literal values excluded — so renamed copies still match. |
| [`ts/graph/cycles`](graph/cycles/README.md) | Finds import cycles as strongly-connected components of the resolved module graph — one finding per cycle group, with cycles made only of `import type` edges downgraded to info. |
| [`ts/graph/dead-exports`](graph/dead-exports/README.md) | Finds exports nothing imports and files nothing references, by resolving every import edge — tsconfig path aliases included — into a project-wide module graph. |
| [`ts/refactors/change-signature`](refactors/change-signature/README.md) | Converts positional parameters to a destructured options object, rewriting every call site — the one signature change whose characteristic failure the guard can see, because named arguments remove it. |
| [`ts/refactors/enum-to-const-object`](refactors/enum-to-const-object/README.md) | Converts an `enum` into an `as const` object plus a same-named type — dropping the reverse mapping, the numeric assignability, and the runtime enum object. |
| [`ts/refactors/extract`](refactors/extract/README.md) | Lifts a selection into a function, constant, method, or field, addressed by the code itself rather than by character offsets — TypeScript widens an approximate range and extracts something else without saying so. |
| [`ts/refactors/extract-class`](refactors/extract-class/README.md) | The god-class split: members into a new class held behind a private field, with the dependency analysis that decides whether the split is even possible. |
| [`ts/refactors/extract-interface`](refactors/extract-interface/README.md) | Generates an interface from a class's public members and — the half that buys something in a structurally typed language — rewrites use sites from the concrete class to it. |
| [`ts/refactors/extract-superclass`](refactors/extract-superclass/README.md) | Pulls members into a new base class — the one member-move with no reference rewrite at all, because inheritance preserves every call site. |
| [`ts/refactors/extract-type`](refactors/extract-type/README.md) | Lifts an inline type into a named alias or interface, and — the half TypeScript will not do — finds the same shape written elsewhere in the project. |
| [`ts/refactors/inline-function`](refactors/inline-function/README.md) | Replaces calls with the function's body and deletes it — parenthesizing from the compiler's own rules, and refusing where a name would silently rebind or an effect would be duplicated. |
| [`ts/refactors/inline-parameter`](refactors/inline-parameter/README.md) | Removes a parameter every call site passes the same value for, binding that value in the body — with arguments matched through the resolved signature, not by counting commas. |
| [`ts/refactors/inline-type-alias`](refactors/inline-type-alias/README.md) | Substitutes a type alias's right-hand side at every use and deletes it, parenthesizing from the compiler's own type factory. |
| [`ts/refactors/inline-variable`](refactors/inline-variable/README.md) | Replaces every read of a `const` with its initializer — refusing where TypeScript's own version silently changes precedence, capture, evaluation count, or identity. |
| [`ts/refactors/introduce-parameter`](refactors/introduce-parameter/README.md) | Turns an expression inside a function into a parameter, passing it at every call site — the inverse of inline-parameter. |
| [`ts/refactors/invert-boolean`](refactors/invert-boolean/README.md) | Inverts a boolean's sense at every site, sound only when the checker says the type is exactly `boolean` — truthiness makes `!x` not an inversion for anything wider. |
| [`ts/refactors/make-readonly`](refactors/make-readonly/README.md) | Adds `readonly` to a property nothing writes outside the constructor, classifying references by parent node so a destructuring read is not mistaken for a write. |
| [`ts/refactors/member-form`](refactors/member-form/README.md) | Converts a member between method, accessor and field spellings, rewriting the reads, writes and calls each change breaks. |
| [`ts/refactors/module-form`](refactors/module-form/README.md) | Converts between default and named exports, and between namespace and named imports — rewriting every importer, and every `ns.member` access. |
| [`ts/refactors/move-file`](refactors/move-file/README.md) | Moves a file and rewrites every module specifier that resolves to it, plus the ones it writes itself — in TypeScript the path is part of the module's identity. |
| [`ts/refactors/move-instance-method`](refactors/move-instance-method/README.md) | Feature-envy surgery: moves a method onto the class of one of its parameters or fields, flipping the receiver at every call site. |
| [`ts/refactors/move-member`](refactors/move-member/README.md) | Moves a static member to another class or down to module scope, re-pointing every reference and carrying its imports. |
| [`ts/refactors/move-symbol`](refactors/move-symbol/README.md) | Moves a top-level declaration into another file, existing or created, dragging its imports along and redirecting every importer and barrel re-export. |
| [`ts/refactors/pull-members-up`](refactors/pull-members-up/README.md) | Moves members into a base class, or copies a signature into an interface — which is all an interface can hold. |
| [`ts/refactors/push-members-down`](refactors/push-members-down/README.md) | Copies members into the subclasses that use them and deletes them from the base, over a subclass set `ts.Program` does not index. |
| [`ts/refactors/rename`](refactors/rename/README.md) | Renames a symbol project-wide via the language server, dry-run by default, refusing renames that would introduce compile errors. |
| [`ts/refactors/safe-delete`](refactors/safe-delete/README.md) | Deletes a declaration only after proving nothing references it, removing what it orphans — and naming the reference forms TypeScript cannot see. |
| [`ts/refactors/static-form`](refactors/static-form/README.md) | Adds or removes `static`, rewriting every call between `instance.m()` and `Class.m()` — with arguments mapped through the resolved signature. |
| [`ts/refactors/widen-type`](refactors/widen-type/README.md) | Replaces an annotation with the least specific type that still typechecks — a search, because "still typechecks" is exactly what the guard computes. |
| [`ts/types/loopholes`](types/loopholes/README.md) | Audits type-safety escape hatches — assertions, non-null `!`, explicit `any`, and suppression directives — grading each by how much checking it discards. |

Every tool here also takes `files`, a list of paths to report findings in, so a hook can check just what changed without narrowing the analysis behind the findings — see [check only what changed](../README.md#check-only-what-changed).

## Layout

- `server/` — spawns `typescript-language-server` and completes the LSP handshake
- `project/` — binds to a project on disk; owns the LSP and compiler views, and the reporting scope `targetFiles()` applies
- `ferry/` — dispatches tool calls, caching one session per project root and serializing calls against it
- `ast/` — shared AST helpers: declaration-site tests, symbol targeting, structural node identity, the class/interface hierarchy index, name/preview truncation
- `async/`, `comments/`, `dupes/`, `graph/`, `refactors/`, `types/` — the tools
- `refactors/` also holds what every refactoring shares: the in-memory typecheck guard, the reference
  classifier, the wrapper around TypeScript's own refactoring engine, selection addressing,
  signature and substitution analysis, import bookkeeping, and the `WorkspaceEdit` conversion — see
  [the roadmap](../ROADMAP.md#shared-machinery)
- `registry.ts` — registers every shipped tool for the CLI and MCP adapters
