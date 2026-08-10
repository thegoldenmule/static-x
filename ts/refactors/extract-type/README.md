# ts/refactors/extract-type

Lifts an inline type — an object type literal, a union, a function type — into a named `type` alias or `interface`. This is ReSharper's **Introduce type alias** and **Convert Anonymous to Named Type**, which are one operation here because TypeScript offers both forms as actions on the same selection. (Its **Introduce typedef** is the same extraction emitting JSDoc, meaningful only in a `.js` file under `checkJs`.)

**The selection is addressed by its code, not by offsets** — see [`selection.ts`](../selection.ts) for why an approximate range is dangerous. A type is often written where a caret would be fiddly to describe anyway: `within` names the enclosing function, and reaches its signature, so "the parameter type in `connect`" is a thing you can say.

**TypeScript does the extraction, and does it well.** Captured type parameters propagate: `{ value: T; tag: string }` inside a generic function becomes `type Boxed<T> = …`, used as `Boxed<T>`. A function type only permits the alias form, and which forms are available comes back in `forms` rather than being guessed.

**What TypeScript will not do is look at the rest of the project.** The same shape written in five files stays written in five files, and running the refactoring again on the second one produces a second alias with the same body. That is the half worth owning: `duplicates` reports every other inline type in the project structurally identical to this one, and `dedupe: true` replaces them with the new name. It is a cross-file question no model can answer from the file in front of it, because the precondition is knowing what every other file contains.

**Identity is tokens, not shape.** Duplicates are matched with `tokenKey` — names and literal values included. The repo's other primitive, `shapeKey`, deliberately ignores both so that renamed copies of a function still collide; using it here would be actively harmful, because `{ host: string }` and `{ port: number }` share a shape and would be collapsed onto one alias. The fixture contains exactly that pair, and a test asserts they stay apart.

**Duplicates in other files are reported, not rewritten.** The extraction declares the alias in the selection's own file without exporting it, so another file has nothing to refer to. Rewriting it would be a compile error the guard would catch; saying so is more useful than either breaking it or staying silent. Export the alias and run this again there, or move `dedupe` to that file.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied. Any introduced diagnostic is returned in `newDiagnostics` and the edit is refused, even with `apply: true`. It is close to an oracle for the delegated half — a bad extraction is a type error — and a genuine backstop for `dedupe`, where a shape that is textually identical but contextually different shows up as a diagnostic rather than as silent drift.

## Input

| Option | Meaning |
| --- | --- |
| `file` | File the selection lives in (required) |
| `select` | The exact type to lift (required) |
| `within` | Name of the enclosing function, when the same type appears twice in the file |
| `form` | `alias` (default) or `interface` |
| `name` | Name for the extracted type; defaults to TypeScript's placeholder |
| `dedupe` | Also replace identical inline types in the same file (default `false`; needs `name`) |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, forms, name, duplicates }` — `forms` lists what TypeScript offers for this selection, and `duplicates` every identical inline type found, whether or not it was replaced.

```sh
# What is this shape, and where else is it written?
static-x ts/refactors/extract-type --project path/to/project \
  --input '{"file": "src/net.ts", "select": "{ host: string; port: number }",
            "within": "connect", "name": "Endpoint"}'

# Lift it, and fold the duplicates in.
static-x ts/refactors/extract-type --project path/to/project \
  --input '{"file": "src/net.ts", "select": "{ host: string; port: number }",
            "within": "connect", "name": "Endpoint", "dedupe": true, "apply": true}'
```

([Install instructions](../../../README.md#install).)
