# ts/refactors/inline-parameter

Removes a parameter that every call site passes the same value for, and binds that value as a `const` at the top of the function body. "Every caller passes the same value" is exactly the fact the file in front of you cannot contain — the parameter looks load-bearing from inside the function and looks necessary from inside any one caller, and only the whole project says otherwise. This is also the first tool here that *authors* its call-site edits rather than delegating to TypeScript's engine, which has no refactoring for this.

Sameness is structural, not textual: two arguments are the same value when their token streams match (`ts/ast/structural.ts`), so `f(1)` and `f( 1 /* one */ )` agree while `f(1)` and `f(2)` do not. A call that omits the argument entirely counts as passing the parameter's default, so the TypeScript-native shape — a defaulted parameter no caller ever overrides — is covered by the same pass.

**Arguments are matched to the parameter through the checker-resolved signature, never by counting commas.** A `this` parameter occupies a slot in the declaration's parameter list and none in the argument list, so the second declared parameter of `run(this: Ctx, stage: string, message: string)` is the *first* argument of `ctx.run('boot', 'one')`. Indexing the declaration deletes `'one'`. This is the bug `change-signature` must never have, which is why it is proven here first.

**Escapes are refused, not guarded.** Any reference that hands the callee out as a value — `arr.map(f)`, `.call`/`.apply`/`.bind`, `typeof f`, a decorator, a JSX component, a tagged template — checks arity by assignability, where a function with fewer parameters is still assignable. The wrong edit compiles and misbehaves, so the typecheck cannot catch it and the tool refuses at the reference instead, naming its file and position.

**Shared signatures are refused.** An overload set spreads one implementation across several parameter lists; a method that overrides a base member or implements an interface member shares its signature with declarations elsewhere (`ts/ast/hierarchy.ts`). Either way one list's edit describes none of the call sites. A hierarchy whose closure cannot be resolved — a mixin — is refused too, rather than assumed empty.

**The value has to mean the same thing in the callee.** It stops being evaluated in the caller's scope and starts being evaluated in the callee's. A name that does not exist there surfaces as `TS2304` from the guard, but a name that exists there and means something *else* compiles silently, so every root identifier in the value is checked for symbol identity against the callee's scope up front. When the expression can do more than produce a value — a call, a `new`, an `await`, an assignment — the edit is applied with a `warnings` entry saying so.

**Also refused:** a body reading `arguments` (it sees the real argument list, which this edit shortens), a spread call (which argument feeds the parameter is a runtime fact), a rest or destructured parameter, a constructor parameter property, an expression-bodied arrow (there is no statement list to bind into — wrap the body in a block first), a `.d.ts` declaration, a callee nothing calls, and a call site that omits an argument for a parameter with no default.

**Dry-run by default.** Without `apply: true` the tool returns the `WorkspaceEdit` and touches nothing.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied. Anything it would introduce is returned in `newDiagnostics` and the edit is refused — even with `apply: true`. Removing the only inference site for a type parameter lands here.

A required parameter's annotation is exactly the name's type inside the body, so it is carried onto the binding: `const level: string = 'info'`, not `const level = 'info'`, which would narrow `string` to `'info'`. An optional parameter's body type also includes `undefined`, which its annotation does not say, and an unannotated parameter has nothing to carry — both fall back to inference, and the guard checks what that produced. The parameter's JSDoc `@param` line moves with it, becoming the binding's own doc comment, or `ts/comments/stale-refs` would flag the leftover immediately.

## Input

| Option | Meaning |
| --- | --- |
| `parameter` | Parameter to inline: its name, or its zero-based index among the value parameters — a `this` parameter is not one (required) |
| `symbol` | Target the function, method, or arrow-valued const by name; errors with candidate locations if ambiguous across files |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, value, callSites }` — `value` is the common argument expression as printed into the body, and `callSites` lists every call the edit rewrites (including those that already omitted the argument and only gained the default).

```sh
static-x ts/refactors/inline-parameter --project path/to/project \
  --input '{"symbol": "log", "parameter": "level", "apply": true}'
```

([Install instructions](../../../README.md#install).)
