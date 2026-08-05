# ts/comments/llm-tells

Finds comments with the hallmarks of LLM-generated text. Three detectors, all scoped to real comment ranges (never strings):

- **Filler phrasing** — "it's worth noting", "seamlessly", "delve", "leverages", "robust", "battle-tested", and friends. The full list with weights lives in [`patterns.ts`](patterns.ts); tune it there.
- **Change-log prose** — comments describing the edit instead of the code ("Fixed the bug where…", "Now uses…", "Updated to handle…"). That story belongs in a commit message.
- **Narration** — comments that restate the line below them ("Return the total count" above `return totalCount;`), detected by token overlap with camelCase-aware matching.

Each matched pattern contributes its weight; a comment is flagged when the sum reaches `minScore` (default `1`), so strong tells flag alone and weak ones need company.

## Input

| Option | Default | Meaning |
| --- | --- | --- |
| `minScore` | `1` | Minimum summed pattern weight to flag a comment |

## Output

`Finding[]` with code `comment.llm-tell`, severity `info`, and `data: { score, matches }` listing the matched pattern ids.

```sh
static-x ts/comments/llm-tells --project path/to/project --input '{"minScore": 2}'
```

([Install instructions](../../../README.md#install).)
