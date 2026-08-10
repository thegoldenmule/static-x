# ts/refactors/inline-function

Replaces every call to a function with its body and deletes the declaration. This is ReSharper's **Inline Method**, and the machinery it runs on is what makes **Inline Variable**, **Inline Field** and **Inline type alias** shippable rather than hazardous.

**This tool refuses a lot, and that is the design.** It inlines a function whose body is a single expression — one `return`, or an expression-bodied arrow — and declines everything else. The alternative to refusing is not that the caller waits; it is that the model inlines by hand and `tsc` says nothing about what it got wrong.

**Parentheses come from the compiler, not from a rule written here.** TypeScript's own `Inline variable` parenthesizes on precedence rank with no test for operand position, so `const d = a - b; return c - d` becomes `return c - a - b` — which compiles, and is arithmetic rather than a type error. Here the substituted body is built with the compiler's factory and printed, which applies TypeScript's own parenthesizer, and the result is wrapped again if the position it lands in requires it. `c - difference(10, 4)` with a body of `a - b` becomes `c - (10 - 4)`.

**A name that means something else at the call site is a refusal.** The body's free names are re-resolved at every call. One that resolves nowhere is a compile error the guard would catch anyway; one that resolves to a *different* symbol compiles perfectly and silently computes something else, and that is the case this check exists for. A function reading a module-local `SCALE` will not be inlined into a block that declares its own.

**An argument that could do something observable is never duplicated.** If the body reads a parameter more than once and the argument is a call, an assignment, an `await` — anything with an effect — inlining would change how many times it happens. `twice(bump())` is refused rather than turned into `bump() + bump()`.

**Also refused:** the callee handed out as a value, where arity is checked by assignability; spread calls; overload sets, where a call may not resolve to this body; recursion; a body using `this`, which means something else once moved; a destructured or rest parameter; and a method that overrides or implements another, since inlining one would change what the others mean.

**Orphaned imports go too.** Once the calls are gone, a file's `import { difference }` names something that no longer exists — a hard error, not untidiness. The specifier is removed, and the whole statement when it bound nothing else.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied. Any introduced diagnostic is returned in `newDiagnostics` and the edit is refused, even with `apply: true`. Note what the guard cannot do here: the precedence and capture failures above both compile. They are prevented by construction, not caught — which is why they are checked before the edit is built rather than after.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Function, method, or arrow-valued const to inline |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `keepDeclaration` | Leave the declaration in place (default `false`) |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, callSites, body }` — `callSites` lists every call replaced along with the text it becomes, and `body` echoes the expression that was inlined.

```sh
static-x ts/refactors/inline-function --project path/to/project \
  --input '{"symbol": "difference", "apply": true}'
```

([Install instructions](../../../README.md#install).)
