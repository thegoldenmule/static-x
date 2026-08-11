# ts/refactors/move-instance-method

Moves an instance method onto the class it envies and flips the receiver, so `a.m(b, c)` becomes `b.m(a, c)`. This is ReSharper's **Move Instance Method**.

**It ports to TypeScript unchanged.** Most entries in [the index](../../../ROADMAP.md) needed adapting, because C# constructs that carry the refactoring — static classes, `ref` parameters, resource files, partial types — either mean something else in TypeScript or mean nothing at all. This one does not: a TS class carries state and prototype methods exactly as a C# type does, so "this method reads more of `B` than of `A`" is the same observation about the same thing, and the fix is the same edit.

**`to` names either a parameter or a field.** `to: "invoice"` where `bill(invoice: Invoice, …)` is a parameter moves the method onto `Invoice` and rewrites `order.bill(invoice, note)` into `invoice.bill(order, note)`. `to: "printer"` where `printer: Printer` is a field of the declaring class moves it onto `Printer` and rewrites `receipt.render(24)` into `receipt.printer.render(receipt, 24)` — the field is how a call site reaches the class that now owns the method. The two produce different call-site rewrites, so a name that is both is a refusal rather than a guess.

**The old `this` becomes a parameter, or disappears.** The chosen parameter becomes `this` in the body; the receiver it displaced becomes an explicit first parameter named after the class it came from, de-conflicted against every name the method already mentions — a parameter that shadowed a function the body calls would compile and call something else. When the body never reads `this` at all, no parameter is added and the argument is dropped instead: `stampOn(invoice, note)` that only touches `invoice` becomes `stampOn(note)`, because a parameter nobody passes is a wrong signature the guard has no reason to complain about.

## What the compiler cannot see, and is therefore decided here

**Argument order.** The argument that becomes the receiver is located through `getResolvedSignature`, never by counting commas. A `this` parameter occupies a declaration slot and no argument slot; an omitted optional means the argument may not be there at all. `transfer(note, invoice)` has its destination at declaration index 1, and the flip has to move argument 2 while leaving the note where it is.

**Evaluation order.** The old receiver went first and is now an argument; the new receiver was an argument and now goes first. `makeOrder().charge(inv)` would evaluate `inv` before `makeOrder()`, which compiles and reorders side effects, so a receiver or a preceding argument that does work is a refusal. Where the reordering is only a *property read* — which runs a getter if one is declared — it is a warning instead, because no syntactic check can tell those apart.

**Member visibility.** `this.x` in the body becomes `<oldReceiver>.x`, which only compiles when `x` is reachable from the destination class. `private` is not, and neither is `protected` or `#name`. The compiler would say so, but at a location inside text this tool generated and about a member the caller never mentioned — so the refusal names the member instead.

**Escapes.** Without `keepDelegate` every use has to be a call this rewrite can describe, and anything else is refused (`assertOnlyCalls`). At an escape the method's signature is checked by assignability rather than at a call, so a flipped parameter list compiles and misbehaves — the one failure the in-memory typecheck is structurally blind to.

## keepDelegate

`keepDelegate: true` leaves `m(b, c) { return b.m(this, c); }` on the class the method came from, and touches no call site at all. That is the only way to move a method that escapes as a value, and the only way to move one whose callers you do not own. `callSites` comes back empty, and the delegate keeps the original signature — including a defaulted parameter, which the moved method could not have kept.

A generator is refused with `keepDelegate`, because a delegate would have to `yield*` rather than `return` and that is a different body with different completion semantics. A destructured parameter is refused for the same kind of reason: a delegate forwards by name, and a pattern has none.

## Other refusals

A `to` whose type is not a class this project owns — a primitive, a union, an interface, a class from `node_modules`. A generic class on either end, since the receiver parameter would need type arguments no call site supplies. A method the hierarchy shares (`memberHierarchy`), and a hierarchy the checker cannot close, where a mixin base means an override could be invisible. A body reading `super`. An overload set, whose call signatures are separate declarations. A destination that already declares the name. A recursive method, where the rewrite would have to edit the text it is moving. A private destination field, which no call site could write. And a `this` that cannot be spelled where the parameter was: a shorthand property, an assignment, or a use inside a nested function that binds its own receiver.

## Imports

The names the moved body depends on are re-resolved at the destination: one already in scope there is left alone, one that resolves to a *different* binding is a refusal, and one that resolves nowhere gets an import written from the binding the source file used. The class being left is imported as `import type`, since it appears only as an annotation and a value import would close a runtime cycle wherever the two files already point at each other. Going the other way, an import the departing method was the last user of is removed — not tidiness, since under `noUnusedLocals` the orphan is a `TS6133` the guard attributes to this edit and refuses the whole move over.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied; anything introduced comes back in `newDiagnostics` and blocks the apply, even with `apply: true`. A `private` method moved onto another class is the clean example: it is private *there* now, so the class it left can no longer call it, and the `TS2341` is what stops the write.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Method to move, by name |
| `class` | Class the method is declared on, when the name is not unique across the project |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `to` | Parameter of the method, or field of the declaring class, whose type receives it |
| `keepDelegate` | Leave `m(b, c) { return b.m(this, c); }` behind so callers are untouched (default `false`) |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, callSites }` — `callSites` lists every call the edit flips, in the pre-edit tree, so a dry run shows the blast radius without reading the edit. It is empty with `keepDelegate`.

```sh
static-x ts/refactors/move-instance-method --project path/to/project \
  --input '{"symbol": "bill", "class": "Order", "to": "invoice", "apply": true}'
```

([Install instructions](../../../README.md#install).)
