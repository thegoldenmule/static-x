# ts/refactors/introduce-parameter

Turns an expression inside a function into a new parameter: every structurally identical occurrence in the body becomes the parameter name, and the original expression is passed at every call site in the project. The exact inverse of [`inline-parameter`](../inline-parameter/README.md), and a *tool* for the same reason — the edit lands in files the caller never opened, and the set of those files is a fact no single file contains.

**The blast radius is wider than the argument lists.** TypeScript's typing is structural, so a function assigned anywhere to a declared function type has its arity checked *there*, by assignability, where the wrong arity compiles and misbehaves. `assertOnlyCalls` refuses that — and refuses it in the `defaultValue` form too, where the arity change is technically assignment-safe: `lines.map(tag)` would quietly start feeding `map`'s index argument into the new optional parameter, and `tsc` would say nothing.

**Every occurrence, not just the selected one.** A parameter that stands for one of two identical sub-expressions is not what anybody means, and leaving the other behind is the sort of half-refactor that reads as done. Sameness is structural, not textual — token streams must match (`tokenKey` in `ts/ast/structural.ts`, never `shapeKey`, which drops names and literals and would conflate `'info'` with `'warn'`) — so comments and layout may differ while the code may not. `occurrences` reports how many were replaced.

**The expression is addressed by its own code.** `select` is the expression itself; `within` names the enclosing function when it occurs in more than one. Nothing is addressed by offsets. `locateSelection` (`ts/refactors/selection.ts`) is the repo's addressing authority and supplies the refusals when a selection names nothing or names a statement run, but it cannot be the primary lookup here: it refuses a selection occurring more than once, which is exactly the case this refactoring exists to serve. So the occurrence set is matched here over the same token keys, and `locateSelection` is asked only when nothing matched.

**Where the parameter goes.** `position` is `'append'` (default) or a zero-based index *among the value parameters* — a `this` parameter is not one of them, because it occupies no slot in the argument list. The argument goes at that same index in each call, so `run(this: Ctx, message: string)` gaining `stage` at index 0 produces `run(this: Ctx, stage: string, message: string)` and `ctx.run('boot', 'one')`. A list already broken across lines gains its parameter on its own line at the same indentation, in the declaration and at each call.

**The parameter's type is the checker's, widened.** `getBaseTypeOfLiteralType` then `getWidenedType`, so `'info'` yields `string` rather than the literal type `'info'`, which would defeat the point. An unannotated parameter would be an implicit `any` under `strict`, so the annotation is never omitted. When the type cannot be *named* where the parameter goes, TypeScript prints it as `import("/absolute/path").T` — which compiles, so the guard is blind to it, while writing a machine-specific path into the source. That is refused, naming the type and telling you to import it.

**`defaultValue` makes it non-breaking.** Given one, the parameter is optional and no call site is touched at all — which is what makes this safe to run on an exported function. `callSites` still reports the calls, because the blast radius is worth knowing even when nothing is written to it. When the default is not the expression it replaced, the edit is applied with a warning: existing callers pass nothing, so the body now evaluates the default instead.

**Refused, because a typecheck cannot see the failure:**

- An expression depending on a parameter or local of the function — a caller cannot evaluate it. Checked directly against the declarations inside the callable, and again with `captureConflicts` at each call, which is what catches a name that exists at the call site and means something *else* there.
- An expression that could do something observable occurring more than once: a parameter is evaluated once, so the remaining evaluations would disappear. Occurring once, it is applied with a warning — it now runs at each call site, before the function is entered.
- A body that assigns to the expression. The assignment would go to the parameter, and the original would silently stop being written.
- `this`, `super`, `arguments`, `new.target` — all bound to the function itself.
- A parameter name that already means something inside the function, which would be shadowed.
- The callee handed out as a value, spread calls, overload sets, a method the class hierarchy shares (`ts/ast/hierarchy.ts`), and recursion — a self-call is both a call site to rewrite and a place an occurrence may sit.
- A call that omits optional arguments before the new parameter's slot: there is nothing to insert between. Give the parameter a `defaultValue`, or place it earlier.
- A `defaultValue` parameter placed where a call already passes an argument. Nothing is written at call sites in that form, so the argument written for the old parameter would start feeding the new one — and two compatible types make that compile.
- A selection that is not an expression inside the body of a *named* function. An anonymous callback has no signature to change, but an expression inside one is reached through the enclosing named function, whose new parameter the callback closes over.

**Warned, not refused:** an exported function gaining a required parameter is a source break for consumers outside the project, and the typecheck only ever sees the call sites inside it.

**Dry-run by default.** Without `apply: true` the tool returns the `WorkspaceEdit` and touches nothing.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied; anything it would introduce is returned in `newDiagnostics` and the edit is refused, even with `apply: true`. The arity rules land here rather than being hand-rolled — appending a required parameter after an optional one is `TS1016`, and the compiler is the authority on that, not this tool.

## Input

| Option | Meaning |
| --- | --- |
| `file` | File the expression lives in (required) |
| `select` | The exact expression to turn into a parameter; whitespace and comments need not match, the code must (required) |
| `within` | Name of the enclosing function, when the expression occurs in more than one |
| `name` | Name for the new parameter (required) |
| `position` | `'append'` (default) or a zero-based index among the value parameters |
| `defaultValue` | Expression to default the parameter to; makes it optional and leaves every call site alone |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, callSites, occurrences }` — `callSites` lists every call the expression is passed at (or would have to be), and `occurrences` counts what the parameter replaced in the body.

```sh
static-x ts/refactors/introduce-parameter --project path/to/project \
  --input '{"file": "src/logger.ts", "select": "'"'"'info'"'"'", "name": "level", "apply": true}'
```

([Install instructions](../../../README.md#install).)
