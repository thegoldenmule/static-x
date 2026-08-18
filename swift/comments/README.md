# comments

The comment family, ported from [`ts/comments`](../../ts/comments/). The rules live in
[`core/comments`](../../core/comments/); this directory supplies the comment stream and this
language's conventions.

## Where the ranges come from

`textDocument/semanticTokens/full`, decoded and filtered to `comment`-typed tokens. Measured against
Swift 6.3.3 on a directory with no project file at all, answering in 52ms:

| Source | Reported as |
| --- | --- |
| `/// doc` | `comment` + `documentation` |
| `// plain` | `comment` |
| `/** doc */` | `comment` + `documentation` |
| `/* plain */` | `comment` |
| `"// not a comment"` | `string` |
| `#"raw // still not"#` | `string` |
| `"\(x) /* nor this */"` | `string` |

A hand-written lexer was the plan until this was measured. It would have had to handle nesting block
comments, `"""` literals, raw strings with matched pound counts, and `\(…)` interpolation containing
its own strings and comments. The server is SwiftSyntax and does all of it, so the lexer does not
exist — and the `documentation` modifier means even the doc/non-doc flag is the compiler's answer
rather than ours.

## Why the doc flag is load-bearing

In TypeScript a doc comment is `/** */`, which `toBlocks` classifies as `block`, which the narration
check skips — a doc summary is *supposed* to name what it documents. In Swift doc comments are
`///`: line comments. Ported naively, every ordinary DocC summary reads as narration.

Measured on `hotseat-app`: 44 narration hits, **26 of them (59%) correct DocC**, of the shape

```swift
/// Restore projection state from a snapshot.
func restore(from snapshot: ProjectionSnapshot) {
```

One predicate fixes it — a doc block is never narratable — and that is not a Swift concession but
TypeScript's own semantics restored under a different comment syntax.

## Directives

```
MARK:  TODO:  FIXME:  HACK:  XXX:  swiftlint:  swift-format-ignore
swiftformat:  sourcery:  periphery:  swift-tools-version
```

`// MARK:` occurs **540 times** in `hotseat-app` alone. It is Xcode's jump-bar structure rather than
prose, so it splits a block the way any directive does; letting it merge would both inflate block
lengths and feed a navigation label to the tell scorer. `// swift-tools-version:` is line 1 of every
package manifest.
