# ts/refactors/member-form

Changes how a class member is *spelled* — method, accessor, or plain field — and rewrites every use site the change breaks.

ReSharper splits this across three index entries: **Convert Method to Property**, **Convert Property to Auto-Property**, and **Convert property to method(s)**. They are one axis with three positions on it, every move along it breaks use sites the same way, and a caller who has to pick between three tool names has to know which direction they are travelling before they can ask. So one tool owns the axis and `to` says where the member should land.

What makes it a tool rather than a text edit is the second half of each conversion. `getFoo()` becoming `get foo()` is two tokens at the declaration and an unbounded number of call sites in files the caller never opened; `o.x = v` becoming `o.setX(v)` is a syntactic reshaping of every write in the project. The compiler finds those references. Nothing short of it does.

**Dry-run by default.** Without `apply: true` the tool returns the `WorkspaceEdit` and touches nothing.

## The three directions

### `to: "accessor"`

From a **zero-argument method**, authored here: `getFoo(): T` becomes `get foo(): T`, and every `x.getFoo()` becomes `x.foo`. The property name is derived by stripping a `get`/`is`/`has` prefix — `getURL` gives `URL`, not `uRL`, because a second capital is left alone — or given outright with `getName`. A method with parameters, type parameters, `async`, `*`, or a `?` is refused: none of those has a property-read spelling.

From a **plain field**, delegated to TypeScript's own `Generate 'get' and 'set' accessors` (`refactor.rewrite.property.generateAccessors`), which produces a private backing field plus the pair. Two measured facts about that engine action shape how it is called:

- **It is offered for a range over the property name, never for a caret.** `getAccessorConvertiblePropertyAtPosition` requires the span to overlap `declaration.name`, so a tool that probes caret offsets finds this refactor at no position in any file. The tool passes the name's exact span, and the test asserts both halves of that measurement rather than trusting it.
- **When the field already starts with `_` it renames the accessor instead.** `_serial` keeps its name, the accessor becomes `serial`, and uses outside the class are *not* rewritten — they go on naming a field that just became private. That is TS2341, which the compile guard catches, and a warning says so before the guard has to.

The engine lists its getter insertion before its setter insertion, and `applyTextEdits` works backwards through the file, so two insertions at one offset come out reversed. The tool re-orders same-position insertions, because a generated pair reading `set` above `get` looks like a defect in this tool rather than an artefact of how edits apply.

### `to: "field"`

A `get`/`set` pair that does nothing but read and write one backing field collapses into a plain property. The backing field is removed and its remaining uses — the constructor assignment, reads elsewhere in the class — are rewritten to the new field. A getter with no setter becomes `readonly`, which the constructor write still permits.

**This conversion discards both bodies**, which is why the triviality test is strict rather than best-effort. The getter must be exactly `return this.<field>;` and the setter exactly `this.<field> = <parameter>;`, on the same field, *through the accessor's own receiver*. That last clause is not a formality: `return this.peer._v` names a field the class also declares, so a check on the name alone would collapse the getter onto another object's state and still compile clean.

The field is written with an explicit type — the getter's declared return type where there is one. `readonly x = 0` would otherwise take the literal type `0` where the getter said `number`, which is the same trap [`make-readonly`](../make-readonly/README.md) documents.

### `to: "method"`

A field or accessor becomes `getX()` / `setX(v)`, and every use is reshaped:

| Use | Becomes |
| --- | --- |
| `o.x` | `o.getX()` |
| `o.x = v` | `o.setX(v)` |
| `o.x += v` | `o.setX(o.getX() + v)` |
| `o.x++` | `o.setX(o.getX() + 1)` |

From an **accessor pair** only the spelling moves: both bodies are kept verbatim, so a `set v` that clamps its argument converts cleanly here even though `to: "field"` refuses the same pair. From a **field**, a private backing field is introduced (`_x`, or `_x2` if taken) and the pair is generated around it; a `readonly` field yields only `getX()`, and its constructor assignment is rewritten to write the backing field directly, since there is no setter to route it through. A `static` member names its class in the generated bodies, as TypeScript's own generator does.

The compound-write expansion is printed through `substitution.ts`, so the compiler's parenthesizer decides the brackets: `v.level *= a + b` becomes `v.setLevel(v.getLevel() * (a + b))`. A precedence-rank rule written by hand emits `v.getLevel() * a + b`, which compiles and is a different number.

## What is refused, and why the guard cannot do it

The in-memory typecheck runs before every write and refuses any edit that introduces a diagnostic — and it genuinely covers the structural half. A class that stops satisfying an interface it never named is `TS2741` at the assignment, which no reference analysis here would have found.

It is silent on everything below, which is why each is decided before an edit is built:

| Refusal | The failure the typecheck cannot see |
| --- | --- |
| A get/set body that does more than move one field | Both bodies are dropped. The clamp, the log, the lazy initialization simply stop happening. |
| A compound write through a receiver that does work — `makeTally().count += 1` | The receiver appears twice in the expansion, so it runs twice. |
| `\|\|=`, `&&=`, `??=` | They assign only when the current value permits; `o.setX(o.getX() \|\| v)` assigns always. |
| An assignment whose value is used — `return (s.value = 7)` | `setX(…)` returns `void`. |
| The same member on both sides — `a.total += b.total` | The expansion replaces the whole expression, swallowing the inner read. |
| A member a base class or subclass also declares | Re-spelling one declaration leaves the others, and the class that still declares the old form goes on satisfying the old contract. `memberHierarchy`'s `unresolved` being non-empty refuses too: a mixin means a declaration could be invisible. |
| A destructured (`const { left } = p`) or detached (`return d.getStamp`) use | There is no call or read spelling for either. |
| A string key — `k['getSize']()` | Found here only because the key is a literal. A computed one is invisible to this tool *and* to the typecheck, which is what the standing `warnings` entry says. |
| A decorated member | A decorator applies to one member kind; changing the spelling changes what it decorates. |
| A `#private` member | Reachable only inside its own class body, so re-spelling one is a single-file edit with no cross-file blast radius — not what this tool is for. |
| A constructor parameter property | Its declaration is a parameter. Re-spelling it edits the constructor signature, which is `change-signature`'s territory. |

## `warnings`

`to: "field"` and `to: "method"`-from-a-field always warn that a field is an own property while an accessor lives on the prototype: `Object.keys`, object spread and `JSON.stringify` see one and not the other, and nothing in the type system records the difference. Conversions that change the member's *name* always warn that a computed-key access (`o[k]`) is invisible to both this tool and the compiler. A method whose body does work warns that a getter now runs on every property access, including one a debugger or a log statement makes.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Member name to target; `#x` matches with or without the hash, but an exact spelling always wins (a class may declare both `#unit` and `get unit()`) |
| `class` | Class the member is declared on, when the same name appears on several |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also narrows `symbol` |
| `to` | `accessor`, `field`, or `method` — required |
| `getName` | Name for the reading half: the accessor (default: `getFoo` → `foo`) or the get method (default `getX`) |
| `setName` | Name for the set method (default `setX`) |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, useSites }` — `edit` is an LSP-compatible `WorkspaceEdit` keyed by absolute file path, and `useSites` lists every reference the conversion reasoned about in the pre-edit tree, each with the classifier's `kind` (`read`, `write`, `compound-write`, `direct-call`, …).

```sh
static-x ts/refactors/member-form --project path/to/project \
  --input '{"symbol": "getTitle", "to": "accessor", "apply": true}'
```

([Install instructions](../../../README.md#install).)
