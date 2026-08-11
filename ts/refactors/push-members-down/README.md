# ts/refactors/push-members-down

Copies members off a base class into the subclasses that use them, deletes them from the base, and writes each copy the imports its body depends on in that subclass's file. This is ReSharper's **Push Members Down**, and the mirror of `pull-members-up`.

## The subclass set is not knowable from the base declaration

`ts.Program` indexes inheritance in one direction. A class declaration carries its `extends` clause, so walking *up* from a subclass is a lookup; walking *down* from a base is a search — there is no reverse-inheritance index, no `getSubclassesOf`, and nothing in the language service that answers the question either. `findReferences` on the class name finds the files that *name* it, which is not the same set and does not tell you which of them extend it.

So the receiving set is built by scanning every heritage clause in the compilation and resolving each `extends` expression through the checker. Two details decide whether that scan is right:

- **An imported base class resolves to the import specifier, not the class.** Without `getAliasedSymbol`, every cross-file `extends` reads as un-analyzable, and a project laid out one class per file has no hierarchy at all. This is the same trap `ts/ast/hierarchy.ts` documents, and it is worth restating because a wrong answer here is silent: the tool would report "nothing extends this" for a class with six subclasses.
- **A heritage clause need not name a class.** `class Audited extends WithAudit(Feed)` is a call expression: no class symbol resolves from it, so the edge is invisible and the closure may be missing a subclass.

## Why an unfollowable `extends` is a refusal

Pushing into a set that is known to be incomplete strips the member from whatever the scan missed. Much of that damage is visible — a subclass that used the member and did not get a copy is `TS2339`, which the guard catches — but the answer would still be wrong for the right reasons, so the tool refuses instead, naming the clause it could not follow.

**The refusal is narrowed to clauses that could hide a subclass of *this* base**, because a blanket rule makes one mixin anywhere in a project block every unrelated hierarchy in it. Two readings of an opaque clause are unioned, and either one is enough:

- its **type** — `WithLogging(Clock)` types as `{…} & typeof Clock`, so the intersection's constituent symbols name the class that was mixed in;
- the **identifiers it mentions**, resolved through the checker, for a factory whose return type the checker widens past recognition.

If either reaches the base or one of its descendants, the push refuses. If neither identifies any class at all, it refuses too — nothing is known about that edge. A mixin over an unrelated class leaves this hierarchy pushable, and so does the `class extends base` *inside* a mixin factory: its base is a type parameter, so it is a subclass of nothing in particular, and every application of the factory is itself a heritage clause this scan reads.

`memberHierarchy`'s own `unresolved` is merged in, but it is not the load-bearing check: it reports an unfollowable edge only where one could hide a declaration of *this member*, which is narrower than "could hide a subclass" — a mixin whose product declares nothing by that name is silent there.

## Which subclasses receive the members

Every subclass, unless `to` narrows it — and then two refusals keep the two halves honest:

- **A receiving subclass that does not use a member is refused**, naming it. Copying a member into a class that never calls it is pure duplication with none of the point, it compiles perfectly, and no typecheck will ever mention it. The message lists the subclasses that *do* use the member, which is the `to` value the caller wanted.
- **A subclass that uses a member and is not in `to` is refused**, because it would lose the member the moment the base stopped declaring it.

Usage is attributed semantically, not lexically. `this.m()` and `super.m()` attribute to the enclosing class, `sub.m()` to the declared type of the receiver, and either way the copy lands in the **direct** subclass on the path from that class to the base — a grandchild inherits it from there. A reference this cannot attribute is a refusal that quotes it: a string key (`channel['signature']`), a detached use, or a read off a **base-typed** value, which is the one case where no set of copies can help, since the declared type is exactly what stops having the member.

**A reference from inside another member being pushed counts as a use by every copy.** `signature()` calls `this.tagline()`; pushed together they land together, and `tagline` is not required to have a caller of its own. Pushed alone, `tagline` is refused because the base's own code calls it.

## The other refusals

Each of these is decided before an edit is built, because the failure is either invisible to a typecheck or would be reported far from its cause:

| Refused | Why |
| --- | --- |
| A member the base's own code calls | The call would have nothing to resolve to. Push the member that calls it down as well, or leave this one. |
| An `abstract` member | It has no body, and the declaration *is* the contract the subclasses implement. Pushing it down deletes the contract rather than moving it. |
| A member a subclass already declares | That override exists because it differs from the base version; a copy would replace it. |
| A member a **base** class also declares | Removing it does not remove the member — the base would inherit the other implementation, silently, everywhere it is still used. |
| A member that reads `super` | `super` means the base's own base here and would mean the base itself once the member sits on a subclass. |
| A `static` member | A static is reached through the class object rather than inherited through an instance; moving one is `ts/refactors/move-member`. |
| A `private` or `#private` member | No subclass can reach it, so every copy would be dead code. |
| A name that means something else at a destination | The copy would compile and compute something different — the failure mode a guard cannot see. |

## Imports, both directions

Every free name in the copied text is re-resolved against each destination's scope. One already bound there to the same binding needs nothing — compared with `sameBinding`, never identity, since an exported declaration referenced from its own file has one symbol from `getSymbolAtLocation` and a different one from `getSymbolsInScope`. One bound to a *different* binding is the refusal above. Everything left is written from the binding the base's file used: a package specifier survives as itself, a relative one is re-based for the subclass's directory, a type-only binding stays `import type`, and two names from one module arrive as one statement — or fold into a clause the destination already has, `import type { Payload }` becoming `import type { Payload, Envelope }`.

Going the other way, an import the base file kept only for the departing member is removed. That is not tidiness: under `noUnusedLocals` the orphan is `TS6133`, which the guard reports as a diagnostic the edit introduced and refuses the whole push over.

## The duplication is the point, and it is a warning

Pushing one member into three subclasses turns one declaration into three. That is what the refactoring does — it is how you break up a base class that grew members only some of its children needed — but nothing keeps the copies in step afterwards, and a later fix to one is not a fix to the others. The count and the class names go in `warnings`.

## Compile guard

Before writing, the project is typechecked in memory with the edit applied; anything introduced comes back in `newDiagnostics` and the push is refused, even with `apply: true`. The clean example is a pushed member that reads a `private` member staying behind: each copy is `TS2341`, and nothing before the edit knows it.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Base class to push members off, by name |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `members` | Member names to push down. Every declaration of each name moves, so a `get`/`set` pair and an overload set stay whole |
| `to` | Subclasses to receive them (default: every subclass of the base) |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, targets, members }` — `targets` lists each receiving subclass and the file it lives in, and `members` the names pushed in the order the base declared them, so a dry run reports the blast radius without the caller reading the edit.

```sh
static-x ts/refactors/push-members-down --project path/to/project \
  --input '{"symbol": "Channel", "members": ["signature"], "apply": true}'
```

([Install instructions](../../../README.md#install).)
