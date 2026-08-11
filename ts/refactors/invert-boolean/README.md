# ts/refactors/invert-boolean

Flips the sense of a boolean function, variable, property, or parameter — ReSharper's **Invert Boolean**. Returns and assignments are negated, every read is negated, and `newName` renames the declaration to match, so `isVisible` becomes `isHidden` and every site that talked about visibility now talks about hiddenness.

## Why `boolean | undefined` is the whole story

`!x` is an inversion of `x` only when `x` is a boolean. TypeScript coerces *anything* to a truth value, so for `boolean | undefined` — the ordinary shape of an optional flag, and the single most common thing you would want to invert — `!x` maps `false` **and** `undefined` to the same `true`. A three-valued domain collapses onto two, at every read, silently.

That is not an edge case to mention in passing. It is the failure this refactoring exists to avoid, and nothing catches it: `!x` typechecks for `boolean | undefined` exactly as well as it does for `boolean`, so the compile guard has no opinion, and neither will a reviewer reading a diff of a hundred inserted `!`s. So the checker is asked whether the type is *exactly* `boolean` and everything else is refused before an edit is built.

"Exactly" is a measurement, not a phrase. `boolean` is interned as the union `true | false` carrying `TypeFlags.Boolean` on the union itself, and that one bit separates it from every neighbour: `boolean | undefined` is a plain `Union`, `const on = true` is a `BooleanLiteral`, `T extends boolean` is a `TypeParameter`. The type is read with `getTypeOfSymbolAtLocation` at the declaration, which is what makes an *optional* property fail the test whatever its annotation says — `off?: boolean` has the type `boolean | undefined`, and reading the annotation instead of the symbol would have let it through.

## The guard is blind here, uniquely so

Every site this tool rewrites is boolean before the edit and boolean after it. `diagnosticsIntroducedBy` therefore proves that the edit still *compiles* and nothing whatsoever about it still *meaning the same thing*. It runs anyway — the rename half is genuinely guard-visible, and a stray edit that broke a type would still be caught — but it is not the safety mechanism here, and a caller who reads `newDiagnostics: []` as "this was checked" would be reading it wrong. Every run says so in `warnings`.

What stands in for the guard is that **no reference is silently left alone**. Each one is either rewritten or refused. That is why the refusal list below is long and why it is the interesting part of the tool.

## Negating, structurally

Negation is not a `!` glued to a substring.

- **A double negative collapses.** A read already under a `!` loses it instead of gaining a second, so `if (!isVisible)` becomes `if (isVisible)`. `!e` as a stored value becomes `e` — but only when `e` is itself exactly `boolean`, because `!!s` on a string is a coercion and dropping it would change the type rather than the sense.
- **An equality flips to its exact complement**: `a === b` becomes `a !== b`, `==` becomes `!=`. Relational operators are deliberately **not** flipped. `a < b` and `a >= b` are *both* false when either operand is `NaN`, so rewriting `!(a < b)` as `a >= b` changes the answer — quietly, and only for the inputs nobody tests with. Those get a `!` like anything else.
- **A boolean literal flips**: `return true` becomes `return false`, not `return !true`.
- **Brackets come from the compiler.** Where a `!` has to be inserted, the operand is handed to `factory.createPrefixUnaryExpression`, which runs `parenthesizeOperandOfPrefixUnary`; whether the result needs bracketing *where it lands* is asked by rebuilding the parent node through `visitEachChild` — which routes through the same `factory.updateX` calls the emitter uses — and seeing whether the parenthesizer wrapped it. So `isVisible = a && b` becomes `isVisible = !(a && b)`, `isVisible.toString()` becomes `(!isVisible).toString()` (`!` binds looser than `.`, so the naive form would negate the string), and `isEnabled(l) && l > 1` becomes `!isEnabled(l) && l > 1` with nothing added, because `!` already binds tighter than `&&`.

  The shared `substitution.ts` helper `needsParentheses` is deliberately conservative for arbitrary inlined expressions and is one pair too eager for a `!`, which is the only reason it is not used here.
- **Brackets that were only holding the `!` go with it.** Cancelling a `!` asks the parenthesizer the same question in reverse, so `(!isVisible).toString()` returns to `isVisible.toString()` rather than leaving `(isVisible)` behind. Without this the tool stops being its own inverse and brackets pile up with every run. A consequence worth knowing: brackets already redundant in the source are dropped along with them.

**The tool is its own inverse**, and there is a test that runs it twice and diffs against the original file. Every branch above is an involution, so it has to be.

### `x = !x` survives

A self-toggle is its own inverse, so inverting the property must leave `this.expanded = !this.expanded` exactly as it was. The write wants to cancel that `!` (its stored value is negated) and the read inside it wants to cancel the same one (its value is negated). A `!` can only be cancelled once, so value sites are planned first and claim it; the read, denied, inserts one instead — and the two edits meet in the middle. Getting this wrong yields either `= this.expanded`, a toggle that stopped toggling, or an overlapping-edit crash.

## The rename is delegated, and merged into one edit

`newName` does not reimplement renaming — it calls `ts/refactors/rename`, which goes through the language server's `prepareRename`/`rename` and therefore already handles imports, re-exports, property accesses, and shorthand expansion. The two edits are carried in **one** `WorkspaceEdit` and guarded together, which works because they cannot collide: the rename rewrites identifier spans and nothing else, while every edit this tool makes is a bracket, a `!`, an operator token, or a `true`/`false` keyword — inserted at expression boundaries or replacing a token that is never an identifier. Disjoint by construction rather than by luck.

One consequence is worth reading the warning for. The language server preserves a re-export's *external* name, so `export { isVisible } from './session.js'` becomes `export { isHidden as isVisible }` — the barrel keeps publishing `isVisible` for a value that now means hidden. That is reported.

## Refusals

| Refused | Why |
| --- | --- |
| A type that is not exactly `boolean` | The whole soundness condition — see above. Covers `boolean \| undefined`, an optional property, a `const` with a literal type, a type parameter, `any`. |
| A member another type in the hierarchy declares | The other declaration keeps the old sense while this one flips. Resolved through `memberHierarchy`, which also refuses when a mixin makes the closure unknowable. |
| A compound assignment | `x ||= e` means `if (!x) x = e`; once `x` means its own opposite, no compound operator expresses that. The statement has to be rewritten by hand first. |
| A destructured reference | `const { loud } = prefs` binds the value to a second name this tool does not follow, and that binding would keep the old sense. |
| A shorthand property | Negating `{ bundled }` means expanding it to `{ bundled: !bundled }`, which also changes what the rename means there. |
| An assignment whose own value is consumed | `if ((flag = compute()))` branches on the stored value, so negating the right-hand side inverts the branch too. Chained assignment is the same problem one level in. |
| A predicate handed out as a value | `apply(positive)` calls it somewhere this edit cannot reach, so the call would not be negated. Uses `assertOnlyCalls` from `signatures.ts`. |
| An overload set | A call may resolve to a body the edit never sees. |
| A second declaration of a merged symbol | Inverting one would leave the other saying the opposite. |
| A target that is not a function, variable, property, or parameter | A class, an interface method signature, an accessor. |
| A `.d.ts` declaration | Nothing to rewrite. |

One reference is deliberately *not* refused. `classifyReferences` reports `typeof x` as an **escape**, which is right for a signature refactoring — that is where a changed signature is checked by assignability instead of at a call. Nothing about a signature changes here: `typeof isVisible` is `boolean` before the inversion and `boolean` after, and `typeof isEnabled` keeps its parameters and its return type. The query names a type and never a value, so it is passed over. Taking the classifier's word for it would have refused every target a `typeof` mentions, for no reason.

## What is rewritten, per target

| Target | Sites |
| --- | --- |
| Function / method / arrow-valued `const` | Every `return` expression in its own body (not a nested callable's), and every call — `f(x)` becomes `!f(x)` |
| Variable | Its initializer, every assignment's right-hand side, every read |
| Property | The same, plus a contextually typed object literal's value: `{ docked: false }` is a write of the property even though the key is syntactically a declaration |
| Parameter | Its default, every read in the body, **and the argument at every call site** — which is why parameter inversion also requires that the owning function is only ever called |

## Warnings

Beside the standing note that the guard cannot see this refactoring go wrong: an exported target, whose sense is now part of a public surface the guard does not typecheck; a barrel that re-exports it; and, for a property, that TypeScript is structurally typed — a value satisfying its container without naming this declaration is not in the reference set and keeps the old meaning.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Declaration to invert |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `newName` | Also rename the declaration, project-wide, through `ts/refactors/rename` |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, sites }` — `sites` lists every expression the edit negates as `{ file, line, character, kind }`, where `kind` is one of `return`, `call`, `read`, `write`, `initializer`, `argument`.

```sh
static-x ts/refactors/invert-boolean --project path/to/project \
  --input '{"symbol": "isVisible", "newName": "isHidden", "apply": true}'
```

([Install instructions](../../../README.md#install).)
