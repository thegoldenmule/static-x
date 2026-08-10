# ts/dupes/functions

Finds structurally identical function bodies (`dupes.function`) by hashing the preorder `SyntaxKind` sequence of each body's AST subtree, each node tagged with its child count so the key encodes the exact tree (`f(g(x), y)` never matches `f(g(x, y))`). Identifier text and literal values are not part of the key, so a copy-pasted function still matches after its variables are renamed and its constants tweaked — the semantic upgrade over token-based duplicate detectors, which lose renamed copies and drown in formatting noise.

Function declarations, function expressions, arrow functions, and class methods (not constructors) with bodies all participate; two matching method bodies in different classes count. Only the body is compared: signatures, modifiers, and return types are invisible to both the key and the exact check, so an `async` wrapper that never awaits groups with its sync twin — merging those is still sound advice, and genuinely different async logic contains `await`, which changes the shape. Functions in the same group are then compared by token-normalized body text: an exact match (identical code tokens — formatting and comments aside, whitespace inside string literals preserved) is a `warning` at `high` confidence — duplicated bodies drift apart silently, so extract one shared implementation and import it. A structural-only match (same shape, different identifiers or literals) is `info` at `medium` confidence, since parallel-but-distinct logic legitimately produces identical shapes; unify the copies if they implement the same rule, otherwise ignore them by `data.name` in `static-x.json`. Each member of a duplicate group gets its own finding, ranged over the whole function, listing every peer as `path:line`.

Nested functions participate twice: once standalone and once as part of the enclosing body's shape, so one pasted outer function containing a large inner function yields a group for each — fixing the outer pair resolves both. Small bodies collide by coincidence, so functions below `minNodes` body-subtree nodes are skipped; the default of 35 is calibrated so trivial one-liners never group. Test files are skipped by default — duplicate test scaffolding is usually deliberate — and `includeTests` brings them back.

**Exempt:** getters and setters (accessor boilerplate), constructors (conventionally parallel injection/assignment boilerplate), bodiless overload signatures and ambient declarations, functions below `minNodes`, and test files (`*.test.ts(x)` / `*.spec.ts(x)`) unless `includeTests` is set.

## Input

| Option | Default | Meaning |
| --- | --- | --- |
| `minNodes` | `35` | Minimum body-subtree node count for a function to participate |
| `includeTests` | `false` | Also scan `*.test.ts(x)` / `*.spec.ts(x)` files |

## Output

`Finding[]` with code `dupes.function`, one per member of each duplicate group, range covering the whole function, and `data: { name, group, peers, nodes, exact, confidence }` where `name` is the function's declared or inferred name (file-qualified `'src/foo.ts:(anonymous)'` when none, so ignoring one anonymous duplicate never silences them all), `group` is a 12-hex-char id shared by the whole group, `peers` lists the other members as `{ file, line }` with project-relative paths and **1-based** lines (finding ranges stay 0-based), `nodes` is the body-subtree size, and `exact` marks members with an identical-token twin.

```sh
static-x ts/dupes/functions --project path/to/project --input '{"includeTests": true}'
```

([Install instructions](../../../README.md#install).)
