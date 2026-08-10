# ts/refactors/change-signature

Converts a function, method, or constructor from positional parameters to a single destructured options object, rewriting every call site project-wide: `f(a, b, c)` becomes `f({ a, b, c })`. This is ReSharper's **Transform Parameters**, and the beachhead of **Change Signature**.

**Only this form ships, deliberately.** Reordering two parameters of compatible type, or widening one, produces code that compiles cleanly and misbehaves at run time — the one failure class the in-memory typecheck is structurally blind to, and no amount of analysis closes it. Converting to named arguments doesn't guard against that trap; it removes it, because after the conversion position carries no meaning. The positional edits stay out until they can arrive through this conversion.

**The call sites are the point.** They live in files the caller never opened, and the rewrite reaches namespace-qualified access (`everything.makeOptions(…)`) as readily as direct calls.

**Escapes are refused, not warned about.** Where the function is used as a value — `arr.map(f)`, `.call`/`.apply`/`.bind`, `typeof f`, a decorator, a JSX component — its arity is checked by assignability rather than at a call, so changing the signature there compiles and misbehaves. The [reference classifier](../references.ts) decides this before TypeScript is asked to do anything, which matters more than it sounds: given such a reference, TypeScript reports the refactoring as applicable and then returns *no edits at all*, with no error and no reason. Silence is indistinguishable from success, so the refusal has to come first.

**A partial rewrite is refused.** TypeScript deduplicates call sites by source position without comparing files, so two calls at the same byte offset in different files collapse to one — it rewrites the first, silently drops the second, and reports nothing wrong. Two near-identical sibling files are enough, which is an ordinary shape for handlers, routes and adapters. After the edit, the call sites TypeScript touched are diffed against the ones the classifier found, and a shortfall is an error naming the calls that would have been left behind.

**Also refused:** spread calls, where which argument feeds which parameter is a runtime fact; overload sets, where a call may resolve to a signature the edit does not describe; rest parameters, which collect arguments positionally and cannot become a named field; and a method that overrides or implements another, since a shared signature must change everywhere at once (a hierarchy the checker cannot fully resolve is refused too, rather than assumed empty).

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied. Any introduced diagnostic is returned in `newDiagnostics` and the edit is refused, even with `apply: true`.

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
