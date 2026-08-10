# ts/async/floating-promises

Finds floating promises at statement level: expression statements whose value is thenable — the type has a callable `then` property — but is neither awaited nor otherwise consumed (`async.floating-promise`). Detection is type-aware through the checker rather than call-name matching, so any Promise-typed expression counts (`Promise.all`/`race` included), a union type with any thenable constituent counts (an optional call returning `Promise<void> | undefined` is still a droppable promise), and non-promise calls never false-positive. Each dropped statement is a place where execution continues before the async work finishes and a rejection becomes an unhandled rejection.

A statement is handled when its result is consumed or its rejection observed: `await`, discarding with the `void` operator, assignment and other binary/unary/delete statements (the comma operator excepted — a comma expression's value is its right operand's, so that operand is judged in its place and `(setup(), load());` stays flagged), a chain ending `.catch(handler)` with at least one argument, or `.then(onFulfilled, onRejected)` with both callbacks — a one-argument `.then` and a zero-argument `.catch` observe nothing and stay flagged. Chain links count however they are written (`x['catch'](g)` equals `x.catch(g)`) and through type-level wrappers (`x.catch(g)!`, a trailing `as` cast), which change nothing about rejection handling. `.finally()` handles nothing by itself but is transparent, forwarding its input promise's fate, so a chain ending `.finally(...)` is judged by what sits beneath it: `x.catch(f).finally(g)` is handled while bare `x.finally(g)` is flagged (typescript-eslint's semantics). Handled statements are still traversed inside, so the body of a `void`-discarded async IIFE gets audited on its own terms.

False-positive mitigation is config-first: `data.name` carries the thenable type's symbol name (`'Promise'`, `'FastifyReply'`, ...), falling back to the callee text for anonymous thenables, precisely so one `"ignore": ["FastifyReply"]` entry in `static-x.json` silences an entire fluent-API class. Genuine `Promise`s are `warning` at `high` confidence; other thenables — usually fluent framework APIs whose instances merely happen to be awaitable — are `info` at `medium`.

**Exempt:** statements already handled as above, and test files when `includeTests` is `false`.

## Input

| Option | Default | Meaning |
| --- | --- | --- |
| `includeTests` | `true` | Also scan `*.test.*` / `*.spec.*` files (`.ts`/`.tsx`/`.mts`/`.cts`) — a dropped rejection in a test silently passes the test |

## Output

`Finding[]` with code `async.floating-promise`, range covering the whole statement, and `data: { name, kind, confidence, preview }` where `kind` is `promise` or `thenable` and `preview` is the statement text, whitespace-collapsed and truncated to 60 characters.

```sh
static-x ts/async/floating-promises --project path/to/project --input '{"includeTests": false}'
```

([Install instructions](../../../README.md#install).)
