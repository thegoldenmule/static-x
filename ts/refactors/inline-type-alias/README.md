# ts/refactors/inline-type-alias

Replaces every reference to a `type X = …` alias with its right-hand side and deletes the declaration, project-wide. This is ReSharper's **Inline type alias**.

**The failure it exists to prevent is invisible.** `type Id = string | number` used as `Id[]` becomes `string | number[]` if the substitution is textual — an array of numbers, or a string. That is not a type error. On a scratch project, `type Ids = string | number[]` compiles clean and `firstId('a string')` — which `Id[]` never allowed — is accepted, `tsc` exit 0. So the compile guard cannot be the thing that catches this; the parentheses have to be right by construction.

**Parentheses come from the compiler, not from a rule invented here.** The type-node factories look parenthesizer-free from the outside, and they are not: `createArrayTypeNode` runs `parenthesizeNonArrayTypeOfPostfixType`, `createUnionTypeNode` runs `parenthesizeConstituentTypesOfUnionType`, and the chain continues through intersections, type operators, indexed access, optional tuple elements, and a conditional type's check and extends slots. Those rules run on parsed nodes exactly as on synthesized ones. So the question is asked of the compiler directly: rebuild the use site's parent with the right-hand side in the slot the alias occupied, and see whether the factory wrapped it.

Positions with no rule — a type argument, a tuple element, a member's type, a template-literal span, a function type's return or parameter, a conditional's true and false branches — are delimited by a bracket, a brace, a comma or a keyword. That claim was measured rather than assumed: seven right-hand-side shapes (union, intersection, function, constructor, conditional, `keyof`, `readonly T[]`) spliced unparenthesized into fourteen such positions all re-parse as the same tree.

**And then the answer is checked.** Every substitution is spliced into a copy of the enclosing type, re-parsed, and the node that lands in the slot is compared token-for-token against the right-hand side. If it differs — because a position needs parentheses the factory does not add, or because this tool got the position wrong — the inline is refused instead of written. Disabling the parenthesization confirms the check bites: `Id` in `Id[]` is then refused rather than silently rewritten.

**A name that means something else at the use site is a refusal.** The right-hand side's free names are re-resolved wherever the alias is used. One that resolves nowhere is a compile error the guard would catch anyway; one that resolves to a *different* symbol compiles perfectly and silently means something else. `type Envelope = { frame: Frame; at: number }` will not be inlined into a file that declares its own `Frame` — the fixture's version of that substitution compiles with no diagnostics at all.

**Also refused:** a generic alias, because substituting type arguments positionally — with defaults, constraints and partial inference — is a different and much harder refactoring; an alias declared in or used inside a `declare` block or a declaration file, which is a contract other code compiles against rather than a definition this project owns; a self-referential alias, which has no fixed point; a use in an `extends`/`implements` clause whose right-hand side is not a type reference, since a heritage clause holds a name and `extends { name: string }` is not syntax; an alias nothing refers to (that is `ts/refactors/safe-delete`); and an interface, which is referred to, extended and merged by name.

**Orphaned bindings go too.** `import type { Id }` and `export type { Id } from './types.js'` both name something that no longer exists once the declaration is deleted — TS2305, a broken build. The specifier is removed, and the whole statement when it bound nothing else. The barrel is the one a project-wide edit forgets, because nothing in that file changed to draw attention to it; removing a name from a module's public surface is reported in `warnings`.

**Expect one pair of parentheses more than you would write.** A union substituted into a union comes back as `(string | number) | undefined`, because that is what `createUnionTypeNode` produces. Taking the compiler's answer in every position is what keeps this rule from drifting away from the one the compiler enforces.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied. Any introduced diagnostic is returned in `newDiagnostics` and the edit is refused, even with `apply: true`. Note what the guard cannot do here: the precedence and capture failures above both compile. They are prevented by construction, not caught.

## Not implemented

ReSharper's **Inline typedef** — the same operation over JSDoc `@typedef` in a JavaScript file — is not handled. `ts/ast/targets.ts` does not recognise `JSDocTypedefTag` as a declaration site, so such an alias cannot be addressed by `symbol` at all, and the substitution would be text surgery inside comments rather than in type nodes.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Type alias to inline |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, useSites, definition }` — `useSites` lists every reference the edit replaces, and `definition` echoes the right-hand side that was substituted, as written.

```sh
static-x ts/refactors/inline-type-alias --project path/to/project \
  --input '{"symbol": "Id", "apply": true}'
```

([Install instructions](../../../README.md#install).)
