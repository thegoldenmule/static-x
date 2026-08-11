# ts/refactors/widen-type

Replaces a type annotation with the least specific type that still typechecks everywhere. This is ReSharper's **Use Base Type Where Possible**, and in a structurally typed language it is strictly more powerful than the C# original: the candidates are not limited to declared ancestors, since any type the annotated type satisfies is a legal replacement — including one synthesized from exactly the members the code touches.

**This is a search, not an analysis, and that is the tool's whole character.** Every other refactoring here builds an analysis it hopes is right and keeps the guard underneath as a backstop. Here the guard *is* the answer: "still typechecks everywhere" is literally what `diagnosticsIntroducedBy` computes. So the tool proposes a candidate annotation, typechecks the whole project in memory with it, and keeps the first one that comes back clean. A wrong candidate cannot ship. The worst a bad candidate generator can do is waste a typecheck.

**Why the guard is a complete oracle here, and where it is not.** A type annotation is *erased*: changing one cannot change what the emitted program does, so every consequence of the change is a compile-time consequence, and the compile is exactly what the guard runs. Two things escape that, and both are handled before any candidate is built rather than after, because the guard cannot see either:

- **`emitDecoratorMetadata`.** With it on, the compiler emits `design:type` as a runtime reference to the annotated constructor, so the annotation is no longer erased and widening it changes behaviour. A decorated declaration in such a project is refused.
- **Declaration emit.** The guard typechecks this compilation. An exported annotation is also read by consumers outside it, which no in-project typecheck covers, so the widening is applied and a warning says so.

One hole remains and is not closed: the guard reports diagnostics an edit *introduces*, never ones it removes, so an annotation that silences an existing error would pass. `any` is excluded from the candidates for that reason; a project interface whose members are `any` is not.

## Candidates

`mode: "declared"` (the default) generates named types: the annotated type's `extends` and `implements` ancestors, walked transitively, plus every other named type declared in the project that the annotated type satisfies. `getBaseTypes` reports only `extends` for a class, so `implements` clauses are read off the declarations directly — otherwise `class Dog extends Animal implements Aged` would never offer `Aged`.

`mode: "structural"` prepends one more: a type literal built from exactly the members the project reads off the value. Nothing named can be wider than that, so it is tried first. When no member is read at all, the synthesized candidate is `unknown`. This is the mode that finds a widening when no declared type happens to describe the pair of members in use — `{ readonly age: number; readonly name: string }` where the project declares no such interface. Methods stay methods (`speak(): string`, never `speak: () => string`), because the property spelling is checked contravariantly under `strictFunctionTypes` while the method it came from is bivariant, and the difference costs real widenings.

**Ordering is by assignability, widest first**, so the first candidate the guard accepts is the least specific one that works. "Wider" is a partial order, not a ranking — `Named` and `Aged` are simply incomparable — so candidates come out in layers of maximal elements rather than sorted.

**A cheap prefilter runs before the expensive one.** A candidate missing a member the code actually reads cannot possibly typecheck, so it is dropped without a compile. That is a *necessary* condition only; sufficiency is still the guard's job. It is what makes the common refusal — nothing above this type carries the members in use — cost zero typechecks.

**Candidates that cannot be written down are skipped rather than written wrong.** A generic type would need its type arguments reassembled, and the only ready source of that text is `typeToString`, which falls back to an absolute `import("/Users/…")` path for anything out of scope. A type alias is named by its alias: `type Vitals = { … }` produces a type whose own symbol is the type literal, named `__type`, and trusting that name would propose `__type` as an annotation.

**The bound.** Each candidate costs one whole-project typecheck, so at most `maxCandidates` (default 8, maximum 32) are run. `candidates` reports the whole search space widest-first; everything before `to` was typechecked and rejected, and everything after it was never reached.

**The import comes from the engine.** A base type is usually declared in a file the annotation's file never imported. Rather than re-deciding quote style, specifier extension, and whether an existing import from that module should absorb the name, the tool patches the file in the overlay, reads the `TS2304` that results, and asks the language service for its own `import` code fix — then maps that fix's offsets back through the replacement that produced them. A name already claimed at the annotation by something else is dropped from the candidates instead: an import there would be `TS2440`, not a widening.

**Refusals.** A declaration with no annotation (inference already gave it the widest type its initializer supports); an annotation already `any` or `unknown`; one with no candidate above it; a rest parameter, whose annotation types the whole list; a `.d.ts` declaration; a decorated declaration under `emitDecoratorMetadata`. A `symbol` naming several declarations is refused rather than resolved to the first — three functions in one file with a parameter called `value` are three unrelated symbols, and the shared resolver's same-file tie-break does not apply.

**Known limitation.** The import of the old type is not removed when the widening was its last use. Under `noUnusedLocals` that is `TS6133`, and the guard refuses the widening — measured, with the compiler's own message in `rejected`, so the caller learns exactly why.

**Compile guard.** Non-empty `newDiagnostics` blocks the apply, always. Here it is always empty on success by construction: a candidate that produced any is the definition of one that was rejected.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Parameter, variable, or property whose annotation to widen |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `mode` | `declared` (default) or `structural` |
| `maxCandidates` | Candidates to typecheck, each a whole-project pass (default `8`, max `32`) |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, from, to, candidates, rejected }` — `from` is the annotation as written, `to` the one chosen or `undefined` when nothing widened, `candidates` the search space widest-first, and `rejected` each failure with the compiler diagnostic that ruled it out.

```sh
static-x ts/refactors/widen-type --project path/to/project \
  --input '{"symbol": "pet", "apply": true}'
```

([Install instructions](../../../README.md#install).)
