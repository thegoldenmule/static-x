# ts/refactors/extract-interface

Generates an `interface` carrying the signatures of a class's public instance members, adds `implements` to the class, and rewrites declared types at use sites from the concrete class to the new interface. This is ReSharper's **Extract Interface**, and translating it to TypeScript changes which part of it is worth anything.

## In TypeScript, `implements` is a documented assertion

C# is nominally typed: a method that takes an `IShipping` accepts only types that *say* they implement it, so extracting an interface and adding the clause is what makes a substitute possible at all. TypeScript is structurally typed, and nothing about that carries over. A consumer written `function summarize(kennel: Kennel)` already accepts any value with the right shape; adding `class Kennel implements Boarding` tells the compiler to check `Kennel` against `Boarding` and changes nothing else. **A project that gains an interface and an `implements` clause compiles exactly as it did, with exactly the same coupling — every signature still names the class.**

So the half of this refactoring that buys something is the third one: rewriting `: Kennel` to `: Boarding` at every annotation in the project. That is what lets a caller be handed a test double, a decorator, or a second implementation — and it is a project-wide edit whose precondition ("this code only uses interface members") is knowledge no single file holds. Generating the interface is a snippet. Deciding that every use site can move to it is a tool.

`updateUseSites` defaults to `true` for that reason. Turn it off and the tool says so in a warning rather than implying it decoupled anything.

## What the interface carries

Public instance members: methods, properties, and accessors the class declares. Out by construction are `static` members (an interface describes instances), the constructor (an interface has no construct signature and cannot carry one taken from a class), `private` and `protected` members, and `#name` members, which are unreachable from outside the class body at all. `members` narrows the set further; a name it does not recognise is refused with the eligible list rather than silently ignored.

**Inherited members are not carried.** The interface holds what this class declares, because that is the set whose declarations are here to copy. When a use site reads an inherited member, the rewrite is refused and says so — extract from the class that declares it, or leave the use sites alone.

**Signatures come from the declarations, not from `typeToString`.** That is a measured hazard, not a preference: `typeToString` falls back to `import("/Users/…/src/shapes").Tag` for a name it cannot resolve at the node it is given, which is a machine-specific absolute path and never something to write into a source file. So a written annotation is copied verbatim and the checker is asked only where a declaration wrote nothing — `occupancy = 0` becomes `occupancy: number` — and its answer is refused if it comes back with `import(` in it.

Three details follow from copying declarations:

- **A default becomes optional.** `book(dog: string, nights = 1)` is `book(dog: string, nights?: number): number` in the interface: an initializer is not writable in a signature, and optional is exactly what every caller already sees, since the default is applied inside the body.
- **An overload set keeps its signatures and drops its implementation.** The implementation signature is not part of the type, and writing it into the interface would offer callers a call signature no caller may use.
- **A getter stays a getter.** `get vacancies(): number;` rather than `readonly vacancies: number` — TypeScript has carried accessors in interfaces since 4.3, and the exact form is what round-trips a `get`/`set` pair whose types differ.

Type parameters travel too: `class Crate<T>` yields `interface Crated<T>` and `class Crate<T> implements Crated<T>`, and a use site `Crate<string>` becomes `Crated<string>` — only the name is replaced, so the type arguments are untouched.

## The rewrite, and what stops it

Every reference to the class is classified. Those in type position become the rewrite; everything else is examined for whether it blocks one.

**The guard is the oracle.** A use site that reads a member the interface does not carry is `TS2339` once the edit is applied, so it cannot ship: `diagnosticsIntroducedBy` runs over the whole project with the edit in memory, and a non-empty `newDiagnostics` blocks the apply, always. That covers the cases a cheap analysis cannot reach — a member read off an element of `readonly Kennel[]`, off a call result, off a value that passed through three functions.

**Two refusals are raised before the edit anyway**, because the compiler's message would land somewhere else and would not say what to do about it:

- **A binding the rewrite retypes reads a member the interface does not carry.** The refusal names the read, the site, and whether the fix is `members` or a different class.
- **`typeof C`.** That names the class *object* — what `new` needs — and no interface can stand in for it, since an interface has no runtime value and no construct signature. A namespace-qualified reference (`ns.C`) is refused the same way: this rewrite replaces a plain type reference, and `ns.I` would be a different claim.

**`new C()` is not a use site and is not refused.** Construction needs the class and always will. Those files stay coupled however many annotations move, which is a fact about the refactoring rather than a defect in it, so it is reported as a warning naming the files.

## Imports

`targetFile` puts the interface in another module, existing or created. The destination then needs whatever its signatures name, which is resolved out of the *class file's* scope — the signatures were in scope there by construction — and written as the class file writes it, so a package specifier survives as itself and a relative one is re-based. Every import the interface needs is `import type`: its signatures are erased, and nothing they name is needed at runtime. A signature naming a type the class file declares but does not export is refused, because no other module can write that signature at all.

Consumers get the interface imported where they need it, and **the import of the class is dropped from a file that no longer names it** — not tidiness: under `noUnusedLocals` an orphaned import is `TS6133`, which the guard reports as a diagnostic the edit introduced and refuses the whole refactoring over. A named-import clause that both loses and gains a name is rewritten whole, since two edits in one list overlap at the comma between them.

**Known limitation.** A file that binds the class through a default or namespace import keeps that binding even when the rewrite leaves it unused. Only named import specifiers are pruned.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Class to extract the interface from |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `name` | Name of the interface to generate (required) |
| `members` | Members to carry (default: every public instance member) |
| `targetFile` | Module for the interface, existing or created, relative to the project root (default: the class's own file) |
| `updateUseSites` | Rewrite `: C` annotations to `: I` project-wide (default `true`) |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, members, useSites }` — `members` is what the interface carries, in declaration order; `useSites` is every annotation rewritten, in the pre-edit tree.

```sh
static-x ts/refactors/extract-interface --project path/to/project \
  --input '{"symbol": "Kennel", "name": "Boarding", "targetFile": "src/boarding.ts", "apply": true}'
```

([Install instructions](../../../README.md#install).)
