# ts/refactors/static-form

Changes whether a class member takes a receiver, in either direction. This is ReSharper's **Make Method/Property Static** and **Make Method Non-Static** — two index entries that are one operation on one axis, which is why they are one tool.

**`to: "static"`** adds `static` to a member that never touches instance state and rewrites every `instance.m(…)` into `Class.m(…)`, importing the class where a call site does not already name it. **`to: "instance"`** drops `static` and promotes the parameter named by `receiver`, so `C.m(a, b)` becomes `a.m(b)` at every call site and the parameter becomes `this` in the body.

**The precondition is a `this`-free body, and it is checked rather than assumed.** A method that never mentions `this` is the strongest evidence available that it does not belong to the instance; a static that never mentions `this` is the same evidence in reverse, because in a static `this` is the constructor. The walk looks for `this` and `super` and stops at nested `function`s, methods, accessors, constructors and class bodies, which bind their own `this` and therefore say nothing about this member's. Arrows do not bind their own, so the walk follows them. Both directions refuse on a hit: `this` means the instance in one form and the constructor in the other, and both spellings compile.

**Arguments are mapped through the resolved signature, never by counting commas.** This is the bug [`inline-parameter`](../inline-parameter/README.md) exists to have proved, and the fixture pins it:

```ts
static seal(this: void, vault: Vault, note: string): string
```

`vault` is **parameter 1** and **argument 0** — a `this` parameter is declared in the parameter list and occupies no slot in the argument list. Deleting argument 1 would delete the note and leave the vault. `argumentIndexOf` over `getResolvedSignature` is the only authority on that, and an omitted optional shifts it the same way.

**The TypeScript wrinkle C# has no equivalent for.** TypeScript lets a function *type* its receiver with an explicit `this` parameter — `m(this: C, x: number)` — and it is tempting to read that as C#'s extension method: keep the free function, declare what it is called on, and write `c.m(x)`. It is not. A `this` parameter only constrains the receiver of a function that is *already* reachable through a property; it never makes `c.m(x)` resolve, because nothing has put `m` on `C`. So there is no halfway house between the two forms, and the conversion this tool writes — dropping the parameter, adding the member to the class — is the whole of it. A `this` parameter on the static being converted is dropped along with the receiver, since the body has already been proved not to read it.

**The direction you probably want is `to: "instance"`, and then out of the class entirely.** C# has no module scope, so a static class is how you namespace a helper, and "make it static" is a real destination there. TypeScript files already have their own scope, and a free exported function tree-shakes where a static member drags its class into the bundle. The idiomatic TypeScript move for a `this`-free method is therefore usually `to: "instance"` (so the receiver stops being an argument) or, more often, straight to a module-level function — which is [`ts/refactors/move-member`](../move-member/README.md) with `toFile`. `to: "static"` is here because the C# habit is common in TypeScript codebases and because making the member static first is sometimes the step that makes the move to module scope legal.

## What is refused, and why the guard would not have caught it

| Refusal | The failure it prevents |
| --- | --- |
| `this` or `super` in the body | Means the instance in one form and the constructor in the other. Both compile. |
| A receiver expression that does something — `makeFormatter().trim(x)` | The rewrite drops the receiver, so `Formatter.trim(x)` compiles and no longer builds a formatter. |
| Optional chaining — `fmt?.quote(v)` | `Formatter.quote(v)` compiles and the nullish guard is gone. |
| A reference through a string key or a destructuring | The rewrite cannot describe it, and the reference names the member all the same. |
| An escape — `cells.map(fmt.measure)` (`assertOnlyCalls`) | The member's shape is checked by assignability there rather than at a call. |
| A member the hierarchy shares (`memberHierarchy`) | It has more than one declaration and only one of them would change. An unresolvable hierarchy — a mixin base — is refused too, since an override could be invisible. |
| Accessors | A static accessor is a different member reached with a different call shape at every site. Convert it to a method first. |
| A decorated member | A decorator on an instance member receives the prototype and one on a static receives the constructor. |
| A property anything writes, or whose initializer does anything | An instance property is one slot per instance and a static is one for the program. `startedAt = Date.now()` runs once per instance today and once for the program after. |
| A receiver parameter whose type is not the declaring class | A supertype gives the body a `this` it cannot use; a subtype admits call sites the parameter refused. Moving a method onto the class of one of its *parameters* is a different operation — `ts/refactors/move-instance-method`. |
| A call site that omits the receiver | It takes the parameter's default, and an instance method has no way to express "no receiver". |
| A receiver the body reassigns, or reads inside a function that binds its own `this` | `this` cannot be reassigned, and inside a nested `function` it is not the same receiver. |

Two things are reported rather than refused, because they are outside what any syntactic check can see. A dropped receiver more complicated than a name (`desk.fmt.pad(…)`) calls nothing, but a property read runs a getter if one is declared — that goes in `warnings`. So does a receiver passed as argument 2 or later, which is evaluated first once it moves left of the dot; the arguments it overtakes are checked for calls, and for getters they cannot be.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied; anything introduced comes back in `newDiagnostics` and blocks the apply even with `apply: true`. One consequence worth knowing under `noUnusedLocals`: `to: "static"` drops receivers, and a local that existed only to be one becomes unused, which is `TS6133` and refuses the whole edit. The tool does not delete that binding, because its initializer may be the reason the program works. Remove or inline it first.

Going the other way, `to: "instance"` *does* prune: `C.m(a, b)` → `a.m(b)` can take the last mention of `C` out of a file, and the orphaned import would be the same `TS6133`. An import that is still needed for an annotation is left alone.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Member to change, by name |
| `class` | Class the member is declared on, when the name is not unique across the project |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `to` | `"static"` or `"instance"` — required |
| `receiver` | For `to: "instance"`, the parameter that becomes the receiver |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, callSites }` — `callSites` lists every reference the edit re-points, in the pre-edit tree, so a dry run shows the blast radius without reading the edit. For a property they are reads rather than calls.

```sh
static-x ts/refactors/static-form --project path/to/project \
  --input '{"symbol": "scale", "class": "Money", "to": "instance", "receiver": "amount", "apply": true}'
```

([Install instructions](../../../README.md#install).)
