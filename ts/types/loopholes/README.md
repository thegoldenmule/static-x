# ts/types/loopholes

Audits type-safety escape hatches — the places code overrides or silences the checker instead of satisfying it: type assertions (`types.assertion`), non-null assertions (`types.non-null`), explicit `any` annotations (`types.any`), and checker-suppressing comment directives (`types.directive`). Detection is purely syntactic over the parsed AST and real comment ranges, so `as any` or `@ts-ignore` inside a string literal — or JSX text that merely looks like a comment — can never match and every finding carries `high` confidence.

Severity grades how much checking each loophole discards. A plain `as T` is `info`; `as any` is a `warning` (the expression and everything derived from it leaves the type system); a double-cast like `x as unknown as T` is a `warning` reported once, at the outer assertion (the inner `as unknown` leg is never also flagged) — it can convert between any two types with nothing verified. Explicit `any` is a `warning` on function parameters and return types, where it spreads to every call site and caller (contagion points — a getter's annotation is its return type), and `info` on other annotations; an `any` that appears as the asserted-to type of an assertion is reported as the assertion, not again as an annotation. Non-null `!` is `info`. Among directives, `@ts-ignore` and `@ts-nocheck` are warnings — the first suppresses whatever error the next line produces and silently outlives it, the second turns checking off for the whole file — while `@ts-expect-error` is `info`, since it is assertion-checked and errors itself once the suppressed error disappears. Directive matching mirrors TypeScript's own grammar rather than a lint approximation: in `//` comments, `@ts-ignore` and `@ts-expect-error` match by prefix — tsc honors `// @ts-ignore-me` as a real suppression, so the tool flags it — while the `@ts-nocheck` pragma's name must end at whitespace, a `:`, or the end of the comment, so `@ts-nocheck-me` is inert and ignored. In block comments only the last line counts: `/* @ts-ignore */` and JSDoc `/** @ts-ignore */` genuinely suppress and are flagged, a directive on an earlier line is inert, and a block-comment `@ts-nocheck` never takes effect. A `@ts-nocheck` after the first statement suppresses nothing (tsc only reads the pragma from the top of the file), so it downgrades to `info` with a message saying it is inert.

`data.name` is chosen to read naturally in a `static-x.json` `ignore` list: the asserted-to type's source text for assertions (`'ProjectConfig'`, `'any'`), the operand text for non-null assertions — both whitespace-collapsed and truncated to 40 characters, never splitting a surrogate pair — `'any'` for annotations, and the directive itself (`'@ts-ignore'`) for directives.

**Exempt:** `as const` / `<const>` assertions (a const assertion narrows rather than overrides — the checker still verifies everything), the inner leg of a double-cast, `keyof any` (the checker-verified spelling of `string | number | symbol`), and test files when `includeTests` is `false`.

## Input

| Option | Default | Meaning |
| --- | --- | --- |
| `includeTests` | `true` | Also scan `*.test.*` / `*.spec.*` files (`.ts`/`.tsx`/`.mts`/`.cts`) — a cast in tests is still a cast |

## Output

`Finding[]` with codes `types.assertion` (`data.kind` is `as-any`, `double-cast`, or `assertion`), `types.non-null` (`non-null`), `types.any` (`any`), and `types.directive` (`kind` is the directive text), each with `data: { name, kind, confidence }` and `confidence` always `high`. Assertion and non-null ranges cover the whole expression; `any` ranges cover the keyword; directive ranges cover the comment.

```sh
static-x ts/types/loopholes --project path/to/project --input '{"includeTests": false}'
```

([Install instructions](../../../README.md#install).)
