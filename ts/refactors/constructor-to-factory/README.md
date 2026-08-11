# ts/refactors/constructor-to-factory

Adds a static factory, rewrites every `new C(…)` to `C.create(…)`, and closes the constructor. This is ReSharper's **Replace Constructor with Factory Method**.

**The TypeScript motivation is stronger than the C# one.** A constructor cannot be `async`, cannot return a cached instance, and cannot return a subtype. So a factory is not merely a place to hang policy — it is the only way to build an object that has to await something. Running this first, while the change is mechanical, is what lets the body of `create` become `async` later without touching a single call site again.

**The one unforgivable failure is leaving a `new` behind**, and the interesting half of that is not the half the compiler catches. A closed constructor with a missed site is `TS2673`, which the guard reports and refuses over. The dangerous case is a site the reference search never names at all:

```ts
const { WorkerHandle } = await import("./worker-handle.js");
new WorkerHandle({ workerId, index });          // not a reference to the class
```

That is real code from a real corpus, and it happened twice. So the reference kinds this tool accepts are an **allowlist** — declaration, import binding, export specifier, type position, and `new` — plus reads that reach a static member (`C.VERSION`) or test `instanceof`. Every other kind means the class value reached a binding the search cannot follow, and that is a refusal. Refusing an unfamiliar kind costs a run; passing one costs correctness.

**Only `new C` is rewritten; `<T>(…)` is left exactly as written.** Rebuilding the argument list from each argument's own text was the first attempt, and it silently dropped every comment between arguments — including a `// @ts-expect-error`, whose loss brought back the very error it was suppressing. Not reconstructing text the edit has no reason to touch avoids that whole class of damage: directives, `prettier-ignore`, explanatory notes, and the original line breaks all survive.

**Visibility follows the hierarchy.** `private` would break every `super(…)`, so a class with subclasses gets `protected` instead, and the result says which it chose and why.

**Generics carry over.** `class Box<T>` yields `static create<T>(value: T): Box<T>`, and `new Box<number>(1)` becomes `Box.create<number>(1)`.

**Parameter properties lose only their modifier.** `constructor(private readonly host: string)` gives a factory parameter of `host: string` — `static create(private host: string)` is `TS2369` — while defaults, optionality, rest, and the written type all survive.

## What it refuses

**A class that reaches a binding this cannot follow** — the allowlist above.

**An abstract class**, which nothing constructs directly. **A class with no explicit constructor**, where there is no signature to restate and nothing to close. **Overloaded constructor signatures**, since which overload a site chose is decided per site and one factory cannot restate them all.

**A constructor reading `new.target`.** Its value is the constructor a caller invoked; reached through a factory it is always this class instead, and no part of that is a type change.

**A destructured constructor parameter with no written type.** The factory needs a name to forward and the only type to give it is inferred from the pattern, which cannot be written back out reliably. Annotated, it works — the parameter becomes `arg1: { a: number; b: number }`. (Under `strict` the unannotated form is `TS7031` anyway, so this fires only in looser projects.)

**A factory name already taken by another static member.** Pass a different `name`.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied. Any introduced diagnostic is returned in `newDiagnostics` and the edit is refused, even with `apply: true`. Swept across two real packages it now converts 76 classes with the guard reporting nothing; both defects the guard *did* catch on the first sweep are fixed above, and both were cases where a site was missed rather than mistyped.

## What it warns about

An exported class, whose consumers outside this compilation still call `new` and will stop compiling. And the `protected` fallback, naming the subclasses that forced it.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Name of the class |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `name` | Factory method name (default `create`) |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, factory, visibility, sites }` — `sites` lists every `new` the edit rewrote.

```sh
static-x ts/refactors/constructor-to-factory --project path/to/project \
  --input '{"symbol": "Client", "apply": true}'
```

([Install instructions](../../../README.md#install).)
