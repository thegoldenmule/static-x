# ts/refactors/extract

Lifts a selection into a new function, constant, class method, or readonly field, computing the parameter list, return value, `async`-ness and captured type parameters from data flow through the selection. This is ReSharper's **Extract Method**, **Introduce Variable** and **Introduce Field** in one tool, because TypeScript offers them as *scopes* on a single operation rather than as separate refactorings.

**The selection is addressed by its code, not by offsets.** Pass `select` as the exact statement, run of statements, or expression to lift; indentation, line breaks and comments are free to differ, the code is not. That is not a convenience — it is the correctness property. TypeScript adjusts whatever span it is given out to the nearest node boundaries, so a range starting two characters inside an expression is accepted and silently extracts the *whole* expression instead. A caller that computed offsets would never learn it got something else. Here a selection that is not a whole statement run, expression, or type matches nothing and is refused. See [`selection.ts`](../selection.ts).

**Scope is never guessed.** "Extract to a method on `Cart`" and "extract to a constant in the enclosing scope" are different refactorings with the same input. Called without `scope`, this tool reports what TypeScript offers for the selection and edits nothing; call it again with one of those `scope` values to perform the extraction. A scope that was not offered is refused with the list — asking TypeScript for one it did not offer throws from inside the compiler rather than returning a reason.

**Naming goes through the language service.** TypeScript names the result `newFunction` and reports where a user would start typing. Given a `name`, the tool renames from that point rather than substituting text, so the declaration and every reference move together and the compiler decides what counts as a reference. The placeholder is a fresh identifier, so every rename location falls inside the inserted text; one that reached pre-existing code is reported in `warnings` and the placeholder stands.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied. Any introduced diagnostic is returned in `newDiagnostics` and the edit is refused, even with `apply: true`. The guard is close to an oracle here — a bad extraction is a type error or a syntax error, not a silent change of meaning. It is what catches TypeScript's one remaining defect in this area: extracting to an *inner function* from inside a class method emits a nested `function` whose body still says `this`, which is `TS2683` under `strict`. Prefer the method scope there.

## What it refuses

Beyond a selection that is not a whole statement run or expression: **two string-literal positions where the literal is not a value but a fact the compiler reads out of the source.** TypeScript offers the extraction in both, performs it, and the guard reports nothing — which is the disqualifier this repo opens with, so both are refused before the engine is asked.

| Position | What extraction does | What reports it |
| --- | --- | --- |
| A directive prologue — `'use client'`, `'use server'`, `'use strict'` | `const MODE = 'use client';` — an ordinary string, and the directive stops applying | nothing; the checker models no part of it |
| A module specifier — `import('./m.js')`, `require('./m')` | the call still compiles while the module's type collapses from `typeof import("./m")` to `any`; a bundler loses the static reference | nothing |

Only the *leading run* of string-expression statements is a prologue. A bare string further down a body is a no-op expression, and hoisting it is harmless, so it still extracts.

## Input

| Option | Meaning |
| --- | --- |
| `file` | File the selection lives in (required) |
| `select` | The exact code to lift — a statement, a run of statements, or an expression (required) |
| `within` | Name of the enclosing function, when the same code appears twice in the file |
| `scope` | Which scope to extract into; omit to list the choices |
| `name` | Name for the extracted symbol; defaults to TypeScript's placeholder |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, scopes, name, selected }` — `scopes` carries TypeScript's own descriptions (`Extract to method in class 'Cart'`), and `selected` echoes the code the selection resolved to, so a caller can confirm the right thing moved before applying.

```sh
# What can I do here?
static-x ts/refactors/extract --project path/to/project \
  --input '{"file": "src/cart.ts", "select": "line.qty * line.unit"}'

# Do that one.
static-x ts/refactors/extract --project path/to/project \
  --input '{"file": "src/cart.ts", "select": "line.qty * line.unit",
            "scope": "function_scope_1", "name": "lineTotal", "apply": true}'
```

([Install instructions](../../../README.md#install).)
