# ts/refactors/change-signature

Converts a function, method, or constructor from positional parameters to a single destructured options object, rewriting every call site project-wide: `f(a, b, c)` becomes `f({ a, b, c })`. This is ReSharper's **Transform Parameters**, and the beachhead of **Change Signature**.

**Only this form ships, deliberately.** Reordering two parameters of compatible type, or widening one, produces code that compiles cleanly and misbehaves at run time — the one failure class the in-memory typecheck is structurally blind to, and no amount of analysis closes it. Converting to named arguments doesn't guard against that trap; it removes it, because after the conversion position carries no meaning. The positional edits stay out until they can arrive through this conversion.

**The call sites are the point.** They live in files the caller never opened, and the rewrite reaches namespace-qualified access (`everything.makeOptions(…)`) as readily as direct calls.

**Escapes are refused, not warned about.** Where the function is used as a value — `arr.map(f)`, `.call`/`.apply`/`.bind`, `typeof f`, a decorator, a JSX component — its arity is checked by assignability rather than at a call, so changing the signature there compiles and misbehaves. The [reference classifier](../references.ts) decides this before TypeScript is asked to do anything, and it is the only thing that decides it.

**A conversion TypeScript declines is written here instead.** Given *any* reference it does not recognise as a call, the engine reports the refactoring applicable and then returns no edits at all — no error, no reason. A JSDoc `{@link f}` in another file is enough, which in a documented codebase is ordinary rather than exotic; it turned up on the first real package this was tried against. Nothing about a doc comment makes the conversion unsafe, and the classifier has already established that every real use is a call, so the destructured parameter list is authored here and the call sites with it.

**Calls TypeScript drops are rewritten anyway.** It deduplicates call sites by source position without comparing files, so two calls at the same byte offset in different files collapse to one — it rewrites the first, silently drops the second, and reports nothing wrong. Two near-identical sibling files are enough, which is an ordinary shape for handlers, routes and adapters. Refusing over that would be refusing because of somebody else's dedupe bug, on a function that is perfectly convertible: the engine is wrong about *which calls to visit*, not about what the conversion should be. So after the edit, the calls it touched are diffed against the ones the classifier found, and any it skipped are rewritten here from the same resolved signatures, with the repair reported in `warnings`. A call that genuinely cannot be rewritten is still an error naming it.

**Also refused:** spread calls, where which argument feeds which parameter is a runtime fact; overload sets, where a call may resolve to a signature the edit does not describe; rest parameters, which collect arguments positionally and cannot become a named field; and a method that overrides or implements another, since a shared signature must change everywhere at once (a hierarchy the checker cannot fully resolve is refused too, rather than assumed empty).

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied. Any introduced diagnostic is returned in `newDiagnostics` and the edit is refused, even with `apply: true`. It earns its keep against TypeScript's own output: the engine emits `x?: T` for a defaulted parameter, so under `exactOptionalPropertyTypes` a call passing a possibly-`undefined` value stops compiling. That is a real error in the conversion, and refusing is the right answer rather than something to paper over.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Declaration name to convert |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, callSites }` — `callSites` lists every call the edit rewrites, so a caller can see the blast radius before applying.

```sh
static-x ts/refactors/change-signature --project path/to/project \
  --input '{"symbol": "makeOptions", "apply": true}'
```

([Install instructions](../../../README.md#install).)
