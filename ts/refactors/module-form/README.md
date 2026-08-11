# ts/refactors/module-form

Converts between the forms a module can take — a default export and a named one, a namespace import and named imports — rewriting every file affected.

ReSharper's nearest entry is **Introduce Namespace Alias**, and it is only half the story. C#'s `using X = Some.Long.Namespace` aliases a node in a global namespace tree; TypeScript has no such tree, so the only thing there is to alias is a module specifier, and `import * as ns` is a real runtime binding rather than a compile-time shorthand. The export half has no ReSharper counterpart at all, because C# has no notion of one member of a namespace being the default one.

**The blast radius is the whole point.** Changing a default export to a named one rewrites the import clause in every file that imports it. Converting a namespace import rewrites both the clause and every `ns.member` access in that file — the second half is what makes it more than a one-line edit, and both are in files a caller looking at one module never opened.

**A conversion TypeScript does not offer is refused, and that check is load-bearing.** The engine re-derives its own target from the position and dispatches on what it finds, ignoring the action name it was handed — so asking for a conversion it did not offer performs a *different* one rather than declining. The action is checked against those TypeScript actually lists before anything runs, and the refusal carries the alternatives it does offer.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied. Any introduced diagnostic is returned in `newDiagnostics` and the edit is refused, even with `apply: true`. This is one of the few refactorings where the guard is a *complete* oracle: a missed importer is `TS2613` or `TS1192`, never a silent change of meaning.

## Input

| Option | Meaning |
| --- | --- |
| `file` | File holding the export or import to convert (required) |
| `to` | `named-export`, `default-export`, `named-imports`, `default-import`, or `namespace-import` (required) |
| `symbol` | The exported declaration — for `named-export` and `default-export` |
| `module` | The module specifier — for the import forms |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings }` — `filesChanged` is where the interest is, since it names every importer the conversion reached.

```sh
# A default export becomes a named one, everywhere.
static-x ts/refactors/module-form --project path/to/project \
  --input '{"file": "src/greet.ts", "symbol": "greet", "to": "named-export"}'

# A namespace import becomes named imports, member accesses and all.
static-x ts/refactors/module-form --project path/to/project \
  --input '{"file": "src/app.ts", "module": "./tone.js", "to": "named-imports"}'
```

([Install instructions](../../../README.md#install).)
