# ts/refactors/pull-members-up

Moves members from a derived class up into a type it inherits from. This is ReSharper's **Pull Members Up**.

**The destination decides whether anything moves at all.** In C# the two targets — a base class and an interface — behave the same way from the caller's side: the member's *signature* appears above, and the implementation stays in the class either way, because a C# interface holds none. TypeScript keeps that split and makes it sharper, because a TypeScript base class is an ordinary class and an interface is erased entirely:

| Destination | `asAbstract` | What happens |
| --- | --- | --- |
| base class | absent | The **whole member moves** — declaration, body, JSDoc — out of the derived class and into the base, along with the imports its body needs. |
| base class | `true` | An `abstract` declaration is added to the base; the implementation stays where it is. The base must already be `abstract`. |
| interface | `true` | The **signature is copied** into the interface. The class keeps its body, and it must — see below. |
| interface | absent | Refused, when the member has a body or an initializer. |

**Pulling into an interface is a copy, not a move, and that is not a shortcut.** `class C implements I` is checked against `I`, so a class that stops declaring a member it implements is `TS2420` — the member cannot leave. Only its signature can be lifted, which is a different edit from the one the tool's name suggests, so the tool will not perform it unless it was asked for by name. That is what `asAbstract` means here: *leave a declaration above and the body below*. The flag names the same shape in both destinations, which is why one flag covers both.

**Nothing outside the two types changes.** This is the cheapest member move in the family: inheritance preserves every call site, so `circle.reach(0, 0)` resolves to the pulled-up declaration with no edit at the call at all. There is no project-wide reference rewrite, and files that only *use* the class never appear in `filesChanged`.

**What replaces the reference rewrite is a set of preconditions about state**, and that is where the value is. A member that reads `this.precision` when `precision` is `private` to the derived class cannot compile in its new home; one that reads `this.radius` when the base declares no `radius` cannot either; a `#`-private name is scoped to the class body that declares it, so it can never be read from a base. Each is refused before an edit exists, naming what would be stranded and what to do about it, rather than left to a `TS2339` somewhere the caller did not look. `super` is refused for the same reason with the opposite sign: it still resolves after the move, and it resolves to a *different* object.

**Siblings are reported, not touched.** Another subclass of the same base may declare its own version of the member. Pulling this one up leaves that one alone — deleting it would change which body runs there — but it means the pulled-up member is dead for that subclass, and that is a fact a caller has to be told rather than discover. `siblings` lists them (from [`memberHierarchy`](../../ast/hierarchy.ts)) and a warning says what it means. A hierarchy the checker cannot close is a refusal instead: a mixin base could be hiding a declaration, and an incomplete answer here is worse than none.

**Imports are the other half of a move.** Every free name in the moved code is re-resolved against the base's scope: one already bound there to the same symbol needs nothing, one bound there to a *different* symbol is a refusal (the code would compile and denote something else), and the rest get an import written from the binding the derived file used — a package specifier verbatim, a relative one re-based, a type-only binding as `import type`. A name whose home module does not export it is a refusal, because that is precisely the base's file being unable to name it. Going the other way, an import the derived file kept only for the member that left is removed: under `noUnusedLocals` the orphan is `TS6133`, which the guard would report as a diagnostic this edit introduced and refuse the whole pull-up over.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied, and anything introduced comes back in `newDiagnostics` and blocks the write even with `apply: true`. Two cases show why it stays: a `private` field pulled onto the base is private *there*, so the class it left can no longer read it (`TS2341`); and an `abstract` declaration added to a base makes every other concrete subclass that never declared the member fail `TS2515`. Neither is knowable from the derived class alone.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Derived class to pull members out of, by name |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `members` | Member names to pull up (required) |
| `to` | Destination supertype, required when the class has more than one |
| `asAbstract` | Leave a signature above and the implementation below |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, members, siblings }` — `members` is what was pulled, in declaration order; `siblings` is `{container, file, line}` for every other subtype of the destination that keeps a declaration of its own.

```sh
static-x ts/refactors/pull-members-up --project path/to/project \
  --input '{"symbol": "Circle", "members": ["reach"], "to": "Shape", "apply": true}'
```

([Install instructions](../../../README.md#install).)
