# ts/refactors/extract-class

The god-class split. A chosen subset of a class's members moves into a new class, the original holds one instance of it in a field, and every `this.m()` left behind becomes `this.helper.m()`. This is ReSharper's **Extract Class**.

## The analysis is the tool

A class is a closure over its own state. `members` draws a line through that closure, and the interesting question is never how to move the text — it is whether the line can be drawn at all.

The rule is one-directional, and the direction matters:

- **A member that stays behind and reads state that moved** is the operation, not a problem. `this.discountFor(x)` becomes `this.pricing.discountFor(x)`, in every member that stays, including the constructor. That is the whole point of holding a field.
- **A moved member that reads state staying behind** has nowhere to read it from. There is no back-reference, and adding one would make the two classes mutually dependent — which is not a split. So it is refused, naming both sides:

  ```
  The split cuts a dependency: subtotal reads this.lines. … Either add "lines" to
  members, or leave the reading member behind.
  ```

The analysis runs over `this.x`, `this.m()` and `this['x']` in every chosen member, before any edit exists — because a wrong answer here is not a compile error but a class silently split against a second copy of its own state.

Three bodies are refused outright rather than analysed, for the same reason:

| In a moved member | Why |
| --- | --- |
| `this` as a value — `return this`, `f(this)` | After the move that `this` is the *new* class's instance. Nothing about that changes what compiles. |
| `super.m()` | The new class does not extend the base. The call would have nothing to resolve against. |
| `this[k]` with a computed key | Neither this analysis nor the typecheck can follow it to decide whether the member it names moves. |

A `this[k]` in a member that *stays* is a warning rather than a refusal — it may never name a moved member — but the warning says what the typecheck cannot see.

## The hard decision: what happens to external callers

A moved member that was public has callers this class does not contain. There are exactly two answers and the tool will not pick one for you.

**`delegate: true` (default) — keep a stub.** Every moved member with at least one use that does not go through `this` keeps a delegating declaration on the original:

```ts
/** Percentage taken off the subtotal. */
get discountRate(): number {
  return this.pricing.discountRate;
}

set discountRate(value: number) {
  this.pricing.discountRate = value;
}
```

**No call site changes at all** — `filesChanged` is the class's own file. A member with no external uses gets no stub, so a split of purely internal machinery leaves nothing behind. The cost is honest and reported: the original class still carries the whole public surface it had, so the split has separated the implementation and not the interface.

**`delegate: false` — move the callers.** Every external `obj.m()` is rewritten to `obj.<field>.m()`, and the field is emitted public because it is now part of the class's shape. **This is all-or-nothing.** One use the rewrite cannot describe refuses the whole split:

```
delegate: false rewrites every external use to obj.packing.<member>, and these cannot
be written that way — a destructuring, a string key, or a reference held as a value:
  …/manifest.ts:5:11 (destructure-read: tare)
The rewrite is all-or-nothing: a class with two spellings for one member is worse than
an unsplit one.
```

`externalUses` reports those sites in either mode, in the pre-edit tree, so a caller can look before choosing.

### Stubs the tool will not write

`delegate: true` refuses rather than writing a stub it cannot get right:

- **A destructured parameter.** `fill({ net, tare }: …)` binds its names inside the body; a stub has nothing to forward. Name the parameter, or use `delegate: false`.
- **An overload set.** The stub would have to repeat every signature plus an implementation that fits all of them.
- **A generator.** Delegation there is `return yield*`, not `return`, and this tool does not write it.

A data property's stub is a `get`/`set` pair, which moves it from an own property to the prototype — that changes what `Object.keys`, object spread and `JSON.stringify` see, and nothing in the type system records the difference. It is reported as a warning, because there is no way to delegate a field without it.

## Visibility

A moved member keeps `private`/`protected` when nothing outside the new class reads it — so a split of a private field plus the two methods that use it produces a `private` field in the new class and no widening at all.

When the original still has to reach a moved member — through a stub, or through `this.<field>.x` in a member that stayed — the accessibility modifier is dropped, because `this.<field>.x` is a read from a *different class* and `private` there is `TS2341` rather than a design. That widening is a warning naming the member.

A `#private` name cannot be widened, because `this.<field>.#x` does not exist as syntax. A `#name` moves happily as long as everything that reads it moves too; otherwise the tool refuses and says which side still reads it.

## Where the new class goes, and the field

`targetFile` puts the new class in another module, existing or created. The moved code's free names are re-resolved against the destination and imported the way the class file wrote them, so a package specifier survives as itself and a relative one is re-based; a name the class file declares but does not export is refused, since no other module can write that code at all. The class file gains the import of the new class, and **loses the imports the moved code took with it** — not tidiness: under `noUnusedLocals` an orphaned import is `TS6133`, which the guard reports as a diagnostic this edit introduced and refuses the whole split over.

The default is the class's own file, where the new class is written immediately above the one it came out of.

**Two known limitations in that repair.** Only *named* import specifiers are pruned — a file that binds something through a default or namespace import keeps that binding even when the moved code took the only use of it. And a moved member reached from outside through a computed key (`obj[k]`) is invisible here, exactly as it is to the typecheck; under `delegate: false` such a read is left spelling the old shape. Under `strict` a computed read of a class with no index signature is already an error, which is why this is a note rather than a warning the tool emits.

The field is `private readonly <field> = new <Name>();` (public under `delegate: false` when there are call sites to serve), and it is placed as **the first member of the class body**. That position is load-bearing: field initializers run in declaration order, so a surviving `private cache = this.m()` that this rewrite turns into `this.<field>.m()` would read an undefined field if the field were declared below it — a runtime break with nothing for the typecheck to report. `field` overrides the name, which otherwise is `name` with a lower-cased first letter.

## What the guard catches instead

The analysis above is deliberately narrow, because everything else is decidable by the compiler and `diagnosticsIntroducedBy` runs over the whole project with the edit in memory. The clearest case is a property with no initializer that the constructor assigns:

```
TS2564: Property 'id' has no initializer and is not definitely assigned in the constructor.
TS2540: Cannot assign to 'id' because it is a read-only property.
```

Both are hard errors in code this tool wrote, `newDiagnostics` is non-empty, and the apply is blocked. Assign the property in the new class, or leave it where it is.

## Not this tool

- **A `static` member** is not part of the instance's state, so putting it on an instance held by a field is not what it needs. [`ts/refactors/move-member`](../move-member/README.md) moves a static onto another class or demotes it to a module-level binding.
- **The constructor** initialises the whole object rather than a subset of it. Move the members it assigns and let it keep assigning them through the field.
- **A member a base class or subclass also declares** is not the only declaration of itself; moving one strands the others and the hierarchy stops agreeing about what it means. A hierarchy the checker cannot resolve — a mixin, an unresolved import — is refused for the same reason, since a declaration could be invisible.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Class to split |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `name` | Name of the class to generate (required) |
| `members` | Members to move, by name — `#x` matches with or without the hash (required) |
| `field` | Field on the original holding the instance (default: `name`, lower-cased) |
| `targetFile` | Module for the new class, existing or created, relative to the project root (default: the class's own file) |
| `delegate` | Keep delegating stubs instead of rewriting call sites (default `true`) |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, members, externalUses }` — `members` is what moved, in declaration order; `externalUses` is every use of a moved member that does not go through `this`, in the pre-edit tree.

```sh
static-x ts/refactors/extract-class --project path/to/project \
  --input '{"symbol": "Order", "name": "Pricing",
            "members": ["discountRate", "taxRate", "discountFor", "taxFor"],
            "targetFile": "src/pricing.ts", "apply": true}'
```

([Install instructions](../../../README.md#install).)
