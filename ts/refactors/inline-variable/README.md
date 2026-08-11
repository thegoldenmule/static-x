# ts/refactors/inline-variable

Replaces every read of a `const` with its initializer and deletes the declaration. This is ReSharper's **Inline Variable**, and it is the one entry in the inline family TypeScript already implements outright, as `refactor.inline.variable`.

**It is not delegated, and the reason is measured rather than argued.** Run against TypeScript 5.9.3 on a scratch project, its `Inline variable` produced all four of these. All four compile, and `diagnosticsIntroducedBy` reports nothing for any of them:

| Before | After | What changed |
| --- | --- | --- |
| `const d = a - b; return c - d` | `return c - a-b` | Precedence is ranked without asking which operand the result lands in. |
| `const v = bump(); return v + v + v` | `bump() + bump() + bump()` | One call became three. |
| `const o = {k: 1}; return o === o` | `{k: 1} === {k: 1}` | `true` became `false`. Nothing was called, so a purity check alone would not have caught it either. |
| `const s = SCALE * 2` read in a block declaring its own `SCALE = 100` | `SCALE*2 + SCALE` | 106 became 300. |

A tool whose failures are all invisible to the compile guard is worse than no tool, so every one of these is refused *before* the edit is built. That is what [`substitution.ts`](../substitution.ts) exists for, and this is the tool it was written against.

**This one is project-wide.** TypeScript's engine treats inline-variable as a single-file operation: asked to inline an `export const` read from another module, it returns no edits and no error, which reads exactly like success. Here an exported constant is inlined into every module that reads it whenever its initializer is portable — one made of literals, or of names that resolve to the same symbols at the destination — and the imports and re-export specifiers that reached it are removed along with the declaration. `export { MARGIN, LABEL } from './config.js'` becomes `export { LABEL } from './config.js'`; leaving it would be TS2305 and the guard would refuse the whole edit.

**Parentheses come from the compiler, and from where the read sat.** The substituted expression is built with the compiler's own factory and printed, which applies TypeScript's parenthesizer, and then wrapped again if the position it lands in requires it. `total - OFFSET` with an initializer of `10 - 4` becomes `total - (10 - 4)`. The second test is deliberately two-sided and conservative: an expression nothing can pull apart is never wrapped, a position already delimited by a bracket, comma or keyword is never wrapped, and everything else is — occasionally one pair more than a person would write, never one fewer than correctness needs. `const doubled = w * 2` read as `doubled + 1` gives `(w * 2) + 1`.

**Reads that are not bare identifiers are still reads.** `units.STEP` through a namespace import replaces the whole member access, not the name inside it. `{ doubledW }` becomes `{ doubledW: (w * 2) }`, because `{ w * 2 }` is not an object literal.

## What it refuses

**A binding that is not one value.** A `let` or `var`; a binding written after initialization; a `using` declaration, whose value is disposed when its scope ends (`await using` sets `Const | Using`, so testing for `const` alone accepts it); a destructured binding, which names a property rather than an expression; a loop or `catch` binding; anything with no initializer.

**A read where an expression cannot go.** `typeof SHAPE` wants a name, and an object literal is not one.

**A name that means something else at the read.** Every root identifier in the initializer is re-resolved at each read site. One that resolves nowhere is a compile error the guard would catch anyway; one that resolves to a *different* symbol compiles and silently computes something else, which is the case this check is for.

**A name that means the same thing and holds something else.** The check above cannot see this one:

```ts
let base = 1;
const scaled = base * 2;
base = 5;
return scaled + base;   // 7 today; 15 inlined
```

`base` resolves to the very same symbol at the read. So each root identifier that is a `let`, `var` or parameter is checked for writes anywhere in the project, and any write is a refusal.

**An initializer that would be evaluated a different number of times, in a different order, or not at all.** An initializer that calls, allocates, or reads a property is inlined only when there is exactly one read; the read is in the declaring module; nothing between the declaration and it is a branch, a loop or a nested function; and nothing observable is evaluated in between. So `const next = bump(); return next + 1` inlines to `return bump() + 1`, while `return flag ? tick : 0` and `return cost() + first` are refused — the first would call `bump()` sometimes instead of always, the second would call it after `cost()` instead of before.

Allocation is tracked separately from purity: `{ id: 1 }` calls nothing, and two reads of it are two objects rather than one, which `===` can tell apart and a typecheck cannot.

**An exported constant whose readers are not visible.** Two forms. One that nothing in the project reads at all — its readers, if it has any, are downstream of this compilation, where neither the substitution nor the guard reaches. And one whose declaring module is imported as a whole namespace object and used as one: `registry[key]`, `Object.keys(registry)`, `{...registry}`. A member reached that way is not a reference anyone can find, so deleting it would leave `undefined` at runtime and nothing at compile time. `registry.RATE` — a member access by name — is not that, and is followed and rewritten like any other read.

**An initializer reading `this` from a different receiver.** A read inside an arrow function shares the receiver and is fine; one inside a nested `function` does not.

## What it warns about

An exported constant leaving its module's public surface, and a re-export line going with the declaration: both are visible to consumers outside this project, which the guard does not compile. And an explicit type annotation, where the annotation typed the read and the expression replacing it is not — enough to change an overload choice or a contextual type without changing whether it compiles.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied. Any introduced diagnostic is returned in `newDiagnostics` and the edit is refused, even with `apply: true`. Note what the guard cannot do here: every failure in the table at the top compiles. They are prevented by construction, not caught.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Name of the `const` to inline |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, readSites, value }` — `readSites` lists every read the edit replaces, and `value` echoes the initializer as it was written.

```sh
static-x ts/refactors/inline-variable --project path/to/project \
  --input '{"symbol": "OFFSET", "apply": true}'
```

([Install instructions](../../../README.md#install).)
