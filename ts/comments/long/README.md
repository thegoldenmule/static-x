# ts/comments/long

Finds comment blocks that exceed size thresholds. Long comments tend to restate code, drift out of date, or hide stale context; each finding is a candidate for tightening or deletion.

Comment ranges come from AST node trivia — not text scanning — so comment-like text inside strings, templates, and regexes is never matched. Consecutive whole-line `//` comments merge into one block; block comments stand alone.

**Exempt:** top-of-file license/copyright headers, and directive comments (`@ts-*`, `eslint-*`, `tslint:`, `prettier-ignore`, `/// <reference>`), which also split the block they appear in.

## Input

| Option | Default | Meaning |
| --- | --- | --- |
| `maxLines` | `10` | Flag blocks spanning more than this many lines |
| `maxChars` | `800` | Flag blocks longer than this many characters |

## Output

`Finding[]` with code `comment.long`, an LSP-compatible range covering the block, and `data: { name, lines, chars, maxLines, maxChars, kind }` where `name` is the flattened first 60 characters of the comment (the `ignore` key for `static-x.json`) and `kind` is `line-block` or `block`.

```sh
static-x ts/comments/long --project path/to/project --input '{"maxLines": 20}'
```

([Install instructions](../../../README.md#install).)
