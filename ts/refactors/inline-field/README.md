# ts/refactors/inline-field

Replaces every read of a never-reassigned class property with its initializer and deletes the property. This is ReSharper's **Inline Field**, and TypeScript's engine ships nothing for it.

**Why it is a separate tool from [`inline-variable`](../inline-variable/README.md).** A local is read by name; a field is read through a *receiver*. That single difference is where every hazard this tool exists for lives, and none of them can arise for a `const`:

| Read | Inlined | What changed |
| --- | --- | --- |
| `load().size` | `4096` | The call is gone. The property access was the only thing evaluating it, and the type at that position is unchanged, so nothing is reported. |
| `other.origin` where `origin = this.base` | `this.base` | It now reads the *enclosing* object rather than `other`. Compiles whenever both have a `base`. |
| `node.kind` where a subclass redeclares `kind` | one class's initializer | The read resolved by the receiver's runtime type; the substitution answers for objects it does not describe. |

Everything the two tools share — an initializer duplicated across reads, a name that resolves differently at a read, a name assigned somewhere in between — lives in [`stability.ts`](../stability.ts), which this tool is the second consumer of.

**Parentheses come from the compiler, and from where the read sat.** The substituted expression is built with the compiler's own factory and printed, then wrapped again if the position it lands in requires it. `width - layout.padding` with an initializer of `10 - 4` becomes `width - (10 - 4)`, not the wrong `width - 10 - 4`.

**It is project-wide.** A public field read from four modules is replaced in all four, and the declaration — with the JSDoc that described it — is removed from the class.

**Expect it to refuse most of the time, and know why before you reach for it.** Run over every initialized class property in five real packages — 275 of them — it accepted none:

| Refused | Why |
| --- | --- |
| 104 | Assigned somewhere after initialization, so the field is state rather than a constant |
| 93 | Initializer calls something, and the field is read more than once |
| 40 | The property is also declared on a base, an interface, or an object type alias the class implements |
| 29 | Initializer allocates, so two reads would be two objects |
| 7 | The class extends a mixin, so the hierarchy could not be closed |
| 2 | Nothing reads it — delete it instead |

That is the shape of idiomatic TypeScript, not a defect: class fields are overwhelmingly injected dependencies, mutable state, or fresh collections, and the scalar constant this tool inlines is usually written as a module-level `const` or a `static readonly` in the first place. The tool is worth having for the case it does hit, and worth understanding so the refusals read as information rather than as breakage.

## What it refuses

**A property that is not one value.** Assigned anywhere, including in a constructor, so its reads are not all its initializer; `declare`d or `abstract`, which state a shape and hold nothing; computed-named, where what it is read as is not decided statically; or with no initializer at all.

**A property declared anywhere else in the hierarchy.** A base declaring it or a subclass overriding it means the read is resolved by the receiver at runtime. If the hierarchy cannot be closed — a mixin, an unresolved import — that is also a refusal, because "is it declared elsewhere" is then unknown rather than answered no.

**A decorated property.** A decorator observes the property when the class is defined, so removing it changes what runs, and no part of that is visible to a typecheck.

**A read through a receiver that does something observable.** `load().size`, `next().count`. The access is the only thing keeping that expression alive.

**An initializer reading `this`, at any read not reached through `this`.** An instance initializer describes the object it was declared on. `this.padding` inside the class is fine; `other.padding` is not, and it compiles. Static fields are exempt: `Class.NAME` reaches the same object from everywhere.

**A name that means something else at the read** — every root identifier is re-resolved at each read site — **and a name that means the same thing and holds something else**, where the initializer reads a `let`, `var` or parameter that is assigned somewhere in the project.

An initializer whose names simply are not in scope at a read is refused rather than repaired. `readonly outer = BASE - 4` read from a module that imports only the class needs `BASE` imported there, and this tool does not write that import — the same boundary `inline-variable` has.

**An initializer that would be evaluated a different number of times, or in a different order.** One that calls, allocates, or reads a property is inlined only when there is exactly one read; it is in the declaring module; nothing between the declaration and it is a branch, a loop or a nested function; and nothing observable is evaluated in between. Field initializers run in declaration order inside the constructor, so `readonly doubled = this.count * 2` is a property read and treated as one.

Allocation is tracked separately from purity: `['a']` calls nothing, and two reads of it are two arrays rather than one.

## What it warns about

A non-`private` property leaving the class's public shape, which consumers outside this compilation would notice. And an explicit type annotation, where the annotation typed the read and the expression replacing it is not — enough to change an overload choice or a contextual type without changing whether it compiles.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied. Any introduced diagnostic is returned in `newDiagnostics` and the edit is refused, even with `apply: true`. Note what the guard cannot do here: every row in the table at the top compiles. They are prevented by construction, not caught.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Name of the property to inline |
| `class` | Class it is declared on, when the name is not unique |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, readSites, value }` — `readSites` lists every read the edit replaces, and `value` echoes the initializer as it was written.

```sh
static-x ts/refactors/inline-field --project path/to/project \
  --input '{"symbol": "padding", "class": "Layout", "apply": true}'
```

([Install instructions](../../../README.md#install).)
