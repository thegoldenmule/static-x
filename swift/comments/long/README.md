# swift/comments/long

Comment blocks past a line or character threshold. Long comments often restate the code or hide
context that has gone stale, so each finding is a candidate for tightening or deletion — not a
defect.

## How it works

Comment ranges come from sourcekit-lsp's semantic tokens, so comment-like text inside a string
literal, a raw string, or an interpolation is a `string` token and can never be counted. Consecutive
whole-line `//` comments group into one block; a block comment is one block however many lines it
spans (the server reports it per line, and the ranges are rejoined before grouping).

Two exemptions:

- **License headers**, matched by content and only above the first code in the file. Position alone
  is not enough — an exemption that skipped whatever came first would silently stop reporting the
  first long comment in every file.
- **Directives**, which are dropped and split the block they sit in: `// MARK:`, `// TODO:`,
  `// FIXME:`, `// HACK:`, `// XXX:`, `// swiftlint:`, `// swift-format-ignore`, `// swiftformat:`,
  `// sourcery:`, `// periphery:`, and `// swift-tools-version`.

`// MARK:` matters more than the rest combined — 540 occurrences in one 204-file project. It is
Xcode's jump-bar structure rather than prose, and merging it would inflate the block lengths around
it.

## Input

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `maxLines` | integer ≥ 1 | 10 | Flag blocks spanning more than this many lines |
| `maxChars` | integer ≥ 1 | 800 | Flag blocks longer than this many characters |

## Output

`Finding[]` with `code: "comment.long"`, severity `info`, ranged over the whole block, and
`data: { name, lines, chars, maxLines, maxChars, kind, doc }`. `name` is the flattened head of the
comment and the `static-x.json` ignore key.

`doc` marks a DocC block. They are held to the same threshold as any other comment — a ten-line doc
block is exactly the thing that goes stale — but they are the majority of findings in a documented
codebase, so the flag is there to filter on rather than a second threshold to tune.

## What it reports

| Corpus | Files | Findings |
| --- | ---: | ---: |
| hotseat-app (SwiftPM) | 204 | 35 |
| drum/ios (Xcode) | 82 | 0 |
| War (Xcode) | 393 | 43 |

About 1.2% of comment blocks, the same order as the TypeScript tool on this repository — which is
why the thresholds ported unchanged.

```sh
static-x swift/comments/long --project path/to/project --input '{"maxLines": 20}'
```
