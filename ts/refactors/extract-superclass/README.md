# ts/refactors/extract-superclass

Pulls chosen members out of a class into a newly created base class and makes the original extend it. This is ReSharper's **Extract Superclass**, and it is the cheapest of the five member moves for one reason worth stating plainly.

## Inheritance preserves every call site

`a.m()` still resolves after `m` moves up. `a` is still an `A`, and an `A` still has an `m` — it just arrives from the base now. So **there is no project-wide reference rewrite at all**: no call site changes, no annotation changes, no importer changes. Files that use the class are not even opened by the edit. The apply-mode test asserts exactly that — `filesChanged` for a same-file extraction is one path.

The contrast is [`extract-class`](../extract-class/README.md), which relocates the same members behind a private field. There the receiver changes: `this.m()` becomes `this.helper.m()` and every external `a.m()` becomes `a.helper.m()` or hits a delegating stub. That is an unbounded cross-file rewrite whose precondition is knowledge of every reference in the project. Here the language does the work, and the whole difficulty moves somewhere else: **deciding which members are allowed to go.**

## Visibility across the new boundary, in both directions

A base class and its subclass see different things, and a member that crosses the line lands on the other side of both restrictions.

**Downward — what a moved member may read.** The base does not declare the subclass's members, so anything a moved member reaches through `this` that stays behind is simply not there. This is not a modifier problem; `protected` does not help, because visibility is not the issue — declaration is. The tool resolves every `this.x` through the checker (so a `get`/`set` pair and a constructor parameter property are seen as the members they are) and refuses with the list of names that would have to travel too:

```
record reads this.#chart, this.visits, which would stay on Clinic. A base class does not
declare its subclass's members, so it cannot see them whatever their modifier says. Add
"#chart", "visits" to members so they travel too, or leave the member where it is.
```

A moved member calling a method that stays behind is the same problem written the other way round, and gets the same refusal.

**Upward — what a member left behind may read.** Here the modifier *is* the issue. `private` on a member of the base means private to the base, so a subclass loses access to it; `protected` does not. A moved `private` member that anything still on the subclass reads is therefore promoted to `protected`, and the promotion is reported:

```
Boarding.ledger was promoted from private to protected: `private` on a base member means
private to Boarding, so Kennel would lose the access it has today.
```

## Refusals

**A class that already extends something.** The one with no workaround, and the one that deserves the clearest message: TypeScript is single-inheritance. A class has exactly one base, so there is no second `extends` slot for a generated one. The refusal names the existing base and points at the two refactorings that do apply — pull the members into that base (`pull-members-up`), or extract them into a collaborator (`extract-class`).

**A `#private` member.** A `#name` is scoped to the class body that declares it, and that scoping is lexical and absolute: it is invisible in a subclass, so a base could not hold it and the subclass could not read it. `private` is compile-time privacy and does inherit, so renaming first is a real fix; `#private` is not.

**A `static` member.** A static is reached through the class name, so pulling one up means rewriting every `C.m` — the reference rewrite this refactoring exists not to need. `move-member` owns that operation.

**The constructor.** A derived class's constructor must call the base constructor before it touches `this`, so moving one reorders the initialization of every field the class keeps, and the base would then need the subclass's constructor parameters. Pull the fields up instead. A **constructor parameter property** is refused separately and for a different reason: its declaration lives in the parameter list, so moving it means moving the constructor.

**A member another class in the hierarchy already declares.** Pulling one declaration of a shared member up re-parents the others onto a base this tool has not checked them against. An *interface* the class implements is not refused — the obligation is satisfied through inheritance after the move, and the typecheck confirms it, so it is reported as a warning. A hierarchy `memberHierarchy` cannot close (a mixin, an unresolved `extends`) is refused outright: an incomplete closure could hide a declaration.

**A property whose value comes from the constructor.** `readonly name: string` assigned by `constructor(name)` cannot move: the constructor stays behind, and a `readonly` property may only be assigned inside the class that declares it (`TS2540`), while a base property with no initializer is left uninitialized (`TS2564`). Both are guard-visible, but the compiler's message lands on the constructor and does not say what to do, so the refusal is raised here with the assignment's location.

**A moved member that names the class it is leaving.** The base would depend on its own subclass. When it is a static read (`Clinic.OPENING`), the message says so and points at `move-member`.

## What still changes in the class file

Three things, and nothing else:

1. The members are removed. Adjacent removals are merged into one span so two deletions never claim the same newline — `applyTextEdits` rejects overlapping edits, so this is correctness, not tidiness.
2. `extends Base` is added, before any `implements` clause. The anchor is the body's `{`, never the type-parameter list: `typeParameters.end` is the end of the last *parameter*, so on `class Crate<T>` it addresses the gap before `>`.
3. **`super()` is added to the constructor**, if the class declares one. `TS2377` otherwise. A class relying on the implicit constructor needs no edit — the implicit one already calls `super()`.

## Type parameters, accessors, overloads

**Type parameters travel only when the moved code uses them**, so a class that is generic for reasons unrelated to these members does not get a pointlessly generic base. When they do travel, all of them do, in declaration order with their constraints, and the class extends `Base<T, …>`:

```ts
export class Held<T extends Tag> { items: T[] = []; /* … */ }
export class Crate<T extends Tag> extends Held<T> { /* … */ }
```

**Every declaration under one name travels together.** A `get`/`set` pair is one member spelled twice and an overload set is one member whose type is the list; naming either in `members` moves the whole thing.

## Where the base lands

`targetFile` puts it in another module, existing or created; the default is the class's own file, immediately above the class. When the base moves to another module it gets the imports its code needs, written from the bindings the class file used — so a package specifier survives as itself and a relative one is re-based — and the class file gains the one import the `extends` clause needs. A name that means something *different* at the destination is refused before the edit, because that is the failure a typecheck cannot see: the code compiles and computes something else.

The comparison behind that check is `sameBinding`, never `===`. Measured on this tool's own fixture: moving members into the module that *exports* the constant they read made the tool refuse itself, because `getSymbolAtLocation` and `getSymbolsInScope` return two symbols over one declaration for an exported binding referenced from its own file.

Imports the departing members orphan are dropped from the class file. Not tidiness — under `noUnusedLocals` an orphan is `TS6133`, which the guard reports as a diagnostic the edit introduced and refuses the whole refactoring over.

## The guard is the backstop

Everything above is decided before an edit exists, because none of it produces a message a compiler would. What is left over is handled by `diagnosticsIntroducedBy`, and it catches real things. A member that reads no member through `this` but hands `this` to something typed as the whole class is invisible to every check here, and is `TS2345` with the edit applied:

```
Argument of type 'this' is not assignable to parameter of type 'Pound'.
Type 'Reporting' is missing the following properties from type 'Pound': strays, scan
```

Non-empty `newDiagnostics` blocks the apply, always.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Class to extract the base class from |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `name` | Name of the base class to generate (required) |
| `members` | Members to pull up, by name (required) |
| `targetFile` | Module for the base class, existing or created, relative to the project root (default: the class's own file) |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, members }` — `members` is what the base class carries, in declaration order rather than the order they were named, because the base should read like the code it came out of.

```sh
static-x ts/refactors/extract-superclass --project path/to/project \
  --input '{"symbol": "Kennel", "name": "Boarding", "members": ["occupancy", "admit"], "targetFile": "src/boarding.ts", "apply": true}'
```

([Install instructions](../../../README.md#install).)
