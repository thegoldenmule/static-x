# ts/refactors/enum-to-const-object

Replaces an `enum` declaration with an `as const` object and a type alias of the same name. This is ReSharper's **Convert to scoped enum**, as far as it translates: the C++ refactoring makes enumerators require qualification and stop implicitly converting to `int`, and TypeScript's members are already qualified — so the transferable half is the strictness, and in TypeScript the strictness comes from a different declaration form.

```ts
enum Color { Red = 'red', Blue = 'blue' }
// becomes
const Color = { Red: 'red', Blue: 'blue' } as const;
type Color = (typeof Color)[keyof typeof Color];
```

**The pair shares one name, and that is what makes the edit cheap.** A value and a type may be declared with the same name, so `Color.Red` is still a property read, `let c: Color` is still an annotation, `Record<Color, number>` still has the same keys, and a `switch` over `Color` still narrows. No use site is edited, in any file, through any barrel: `export { Color } from './color.js'` re-exports both meanings exactly as it did.

**What goes away is the reverse mapping, the numeric assignability, and the runtime enum object.** The last one is why this refactoring exists outside style preference. An `enum` is one of the few pieces of TypeScript syntax that emits code, so it is rejected by `erasableSyntaxOnly`, and under `isolatedModules` a `const enum` cannot be inlined across files. A `const` object and a type alias are ordinary JavaScript plus an erasable annotation, which every one of those modes accepts.

## What it refuses

**A `const enum`.** It has no runtime object at all — its members are inlined at each use, and that inlining is the reason to write one. Converting it would be undoing the feature rather than tightening it. Drop the `const` first if the inlining is not wanted.

**A declaration-merged enum.** `enum Level` merged with `namespace Level` is one symbol with two declarations. A `const` and a `type` declare one thing each and merge with nothing, so the other declarations would become redeclarations. The refusal names them.

**A member whose initializer is not a literal.** There are two ways to convert `Large = base * 2` and both are worse than refusing. Keeping the expression widens the member, because `as const` narrows literals only: `{ Large: base * 2 } as const` gives `Large` the type `number`, not `4`, so the union type stops naming the members and the strictness this refactoring exists for is gone. Folding it to the constant the checker already computed keeps the type narrow — `2 | 4` — but rewrites the source into values, cutting the link to whatever the author derived them from. The integration test measures both.

**A reverse-mapping or dynamic read — `Rank[value]`.** A numeric enum's emitted object holds both directions, `Bronze -> 0` and `0 -> 'Bronze'`, and no const object has the second. These are found through the reference classifier and named, rather than left to the compile guard, because **the guard would not always catch them**: the converted expression is TS7053 under `noImplicitAny`, but with `strict` off it is `any`, compiles clean, and evaluates to `undefined` at runtime. A forward read through a literal member name — `Rank['Bronze']` — is not a reverse mapping and is not refused.

**A member used as a type — `kind: Shape.Circle`.** An enum opens a type namespace; a const object does not. Respell it `typeof Shape.Circle`, which works before the conversion and after it, and then run the tool.

**Numeric members used where a number is expected**, which the compile guard reports. The bit-flag idiom is the common case: `Flags.Read | Flags.Write` has type `number`, which a numeric enum type accepts and a union of literals does not, so the assignment becomes TS2322. This one is left to the guard on purpose — it is exactly the class of failure a typecheck sees completely, and the guard's diagnostic carries the position.

Ambient enums (`declare enum`, or anything in a `.d.ts`) are refused too: they describe an object something else creates, and a `const` would assert a runtime shape this project does not build.

## What it warns about

**`warnings` always reports the loss of nominality, because the guard structurally cannot.** An enum type is nominal — only `Color`'s own members were assignable to `Color`, and `const c: Color = 'red'` was an error. The converted type is a union of literals, so a bare literal, or a member of a *different* enum with the same value, now typechecks where it did not. The guard compares diagnostics before and after; this change only ever removes them, so nothing in a green compile could reveal it.

**A numeric enum gets a second warning about its runtime object.** `Object.keys(Dir)` returned four entries for a two-member enum — the names and the numbers — and returns two afterwards. Any site that reads the object itself rather than a member is named. Nothing typechecked observes this.

## Formatting

The object body is the enum's body carried across, with each member's `Name = value` rewritten to `Name: value` and every other character left alone. Doc comments on members, trailing comments, blank lines, indentation and the trailing comma or its absence all survive, which reprinting from the AST would not manage. The declaration's own JSDoc stays above the `const`.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied. Any introduced diagnostic is returned in `newDiagnostics` and the edit is refused, even with `apply: true`.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Enum name to convert |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, members }` — `members` lists the converted members in declaration order, each `value` written exactly as it appears in the emitted object literal, so `{"name": "Red", "value": "'red'"}` and `{"name": "Up", "value": "0"}` are distinguishable at a glance.

```sh
static-x ts/refactors/enum-to-const-object --project path/to/project \
  --input '{"symbol": "Color", "apply": true}'
```

([Install instructions](../../../README.md#install).)
