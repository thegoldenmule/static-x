# claude-comments-ts

Drives [`hooks/claude/ts-comments.mts`](../../hooks/claude/ts-comments.mts). `static-x.json` here is
the example's config surface: a `claude-comments` suite at `changed-lines`, `comments/long` blocking
over two lines, `comments/llm-tells` advisory, and a `ts.comments.long` block the suite layers over.

The test copies this project into a temp git repository and commits it, because `changed-lines`
answers "which lines does this file have that HEAD does not" — a fixture read in place has no history
of its own to diff against.

This file is also the non-source case: the gate must ignore an edit that is not `.ts` or `.tsx`.
