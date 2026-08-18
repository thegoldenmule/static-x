# swift/comments/llm-tells

Comments with the hallmarks of generated text. Three detectors, summed into a score, flagged past
`minScore`.

## The detectors

**Filler** — phrasing that carries no information: "it's worth noting", "seamlessly", "delve",
"leverage", "battle-tested". Strong tells flag alone; weak ones need company. The list lives in
[`core/comments/tells/patterns.ts`](../../../core/comments/tells/patterns.ts) and is shared with the
TypeScript pack, because it needs no Swift entries: measured across 679 Swift files, not one of the
21 patterns needed changing or adding.

**Change-log prose** — a comment that describes the edit instead of the code ("Updated to handle…",
"Now uses…"). Anchored at the start, so it only fires when the comment opens that way.

**Narration** — a comment that restates the line below it. Token overlap against the next source
line, with the comment's words also concatenated in pairs and triples, so `// Return the total count`
matches `return totalCount`. That camelCase trick is most of the tool's value in Swift, where members
are `lowerCamelCase` by convention.

## The one rule that had to change for Swift

A DocC summary sits directly above the declaration it documents and therefore restates it — that is
what a summary *is*. TypeScript gets this for free: its doc comments are `/** */`, which group as
block comments, which the narration check skips. Swift's `///` is a line comment, so a naive port
flags every correct doc comment in the project.

Measured on hotseat-app: 44 narration hits, **26 of them (59%) ordinary DocC**, of the shape

```swift
/// Restore projection state from a snapshot.
func restore(from snapshot: ProjectionSnapshot) {
```

A doc block is never narratable. That is not a Swift concession — it is the TypeScript tool's own
semantics restored under a different comment syntax. 44 → 18.

## Input

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `minScore` | number ≥ 0 | 1 | Minimum summed pattern weight to flag |

## Output

`Finding[]` with `code: "comment.llm-tell"`, severity `info`, and `data: { name, score, matches }`.
`matches` names the patterns that fired, so a finding can be argued with.

## What it reports

| Corpus | Files | Findings |
| --- | ---: | ---: |
| hotseat-app | 204 | 27 |
| drum/ios | 82 | 19 |
| War | 393 | 0 |

Worth knowing what is doing the work: the filler list fired **zero times** across all three. Narration
and change-log prose are the entire signal in Swift.

```sh
static-x swift/comments/llm-tells --project path/to/project --input '{"minScore": 2}'
```
