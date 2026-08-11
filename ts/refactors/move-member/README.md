# ts/refactors/move-member

Moves a static member out of the class that declares it and re-points every reference. This is ReSharper's **Move to Another Type**.

**TypeScript has a second destination, and it is usually the right one.** In C# a static member has nowhere else to go: the language has no module scope, so a static class *is* the namespace and "move to another type" is the whole operation. TypeScript already gives a file its own scope, which means the honest translation of `Pricing.shipping(w)` is very often not `Invoice.shipping(w)` but `shipping(w)` — a plain exported function in a module. Free functions also tree-shake, where a static member is reachable only through its class and drags the whole class into the bundle with it. So `toClass` moves the member onto another class and `toFile` demotes it to a module-level binding; a static method becomes `export function`, a static property becomes `export const`.

**A module-level binding is not this tool's problem.** Moving one between files is `ts/refactors/move-symbol`, which drives TypeScript's own move engine — it exports the symbol, carries the names its body needs, and rewrites every importer's specifier. A target that turns out to be top-level rather than a class member is handed straight to it, and the delegation is reported in `warnings` so the caller knows which tool answered.

**References are re-pointed, not renamed.** Every reference the language service reports must be an `A.m` this rewrite can describe, whether written as a property access or as a qualified name in type position. Anything else is a refusal that names the reference: `Pricing['sku']()` reaches the member through a string key, and `Discounted.label()` reaches it through a subclass that would keep pointing at the class the member left. Both compile today and would compile differently — or not at all — after a naive edit.

**Refusals decided before the edit is built.** A member that reads `this` is refused: in a static, `this` is the class itself, so it would quietly mean a *different* class after a move to `toClass` and nothing at all at module scope. A member that reads another static of the class it is leaving is refused, naming the statics — that dependency is the thing the move is supposed to sever, and the message says to move them first. A member a base class or a subclass also declares is refused (`memberHierarchy`), and so is a hierarchy the checker cannot close — a mixin base means an override could be invisible, and an incomplete answer here is worse than none. A demotion whose new unqualified name already means something else at a call site is refused rather than shadowed.

**Imports are the other half of the move.** The names the moved code depends on are re-resolved at the destination: one already in scope there is left alone, one that resolves to a *different* symbol there is a refusal, and one that resolves nowhere gets an import written from the binding the source file used — a package specifier verbatim, a relative one re-based, a type-only binding as `import type`. Going the other way, the import a file kept only to reach `A.m()` is removed. That is not tidiness: under `noUnusedLocals` the orphan is a `TS6133` that the guard reports as a diagnostic the edit introduced, which would refuse the whole move.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied, any file the move creates included in the compilation. Anything introduced comes back in `newDiagnostics` and the move is refused, even with `apply: true`. A `private static` moved onto another class is the clean example: it is still private there, so the class it left can no longer reach it, and the `TS2341` is what stops the write. Note what the guard cannot see — a static reached through a computed key (`Pricing[key]()`) resolves at runtime, so the tool reports the indexing site in `warnings` rather than pretending it isn't there.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Member (or module-level binding) to move, by name |
| `class` | Class the member is declared on, when the name is not unique across the project |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `toClass` | Destination class — exactly one of `toClass`/`toFile` |
| `toFile` | Destination module, existing or created, relative to the project root; the member becomes a module-level binding |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, references }` — `references` lists every reference the edit re-points, in the pre-edit tree, so the caller can see the blast radius of a dry run without reading the edit.

```sh
static-x ts/refactors/move-member --project path/to/project \
  --input '{"symbol": "shipping", "class": "Pricing", "toFile": "src/freight.ts", "apply": true}'
```

([Install instructions](../../../README.md#install).)
