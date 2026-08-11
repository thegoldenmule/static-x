---
name: static-x-backlog
description: Work down the static-x baseline backlog one file at a time — fix real findings, ignore false positives, and bank each step with `static-x ratchet`. Use when asked to clear the backlog, reduce the baseline, or fix static-x findings.
---

# Working down the static-x backlog

`static-x baseline` records every finding a project already had, so a gate can be
installed without rejecting commits over code nobody in the room wrote. That file
is a debt register. This skill spends it down.

## The loop

One file per iteration. One commit per iteration.

```sh
static-x todo --project . --limit 8          # 1. take the next file's worth
                                             # 2. decide each item (below)
npm run typecheck && npm run lint && npx vitest run   # 3. prove nothing broke
static-x ratchet --project . --apply         # 4. bank it — the baseline shrinks
git commit                                   # 5. one file, one commit
```

Repeat until `static-x todo` exits 0. Then `static-x ratchet --apply` retires the
baseline entirely and the gate starts reporting on everything.

## Each finding gets one of three answers

Deciding which is the whole job. Fixing is not the default.

**Fix it.** The finding is right and you understand the correct change. Make the
smallest edit that resolves it. For a duplicate function, extract one shared
implementation and import it — do not delete one copy and hope.

**Ignore it.** The finding is wrong. This is common and it is a real answer, not
a cop-out: `comment.stale-ref` cannot tell a stale reference from a correct one
naming something outside the project, so a comment citing a TypeScript compiler
API, an SQL function, or a spec symbol is flagged and is not a defect.

Record it in `static-x.json`. Take both values from `static-x todo --format json`
— never guess either one:

- **where**: the item's `tool`, with `/` replaced by `.`, then `ignore`.
  `ts/comments/stale-refs` → `ts.comments.stale-refs.ignore`.
- **what**: the finding's `data.name`, exactly. `ignore` matches it whole.

```json
{ "ts": { "comments": { "stale-refs": { "ignore": ["createArrayTypeNode"] } } } }
```

The `tool` field exists because the path is not derivable from the finding: codes
are singular where tools are plural, and `comment.stale-ref` and
`comment.stale-param` come from the same tool. Append to any `ignore` array
already there rather than replacing it, and leave the `checks` block alone —
that is the gate, not the tuning.

**`ignore` matches project-wide, not per file.** One entry can silence far more
than the finding in front of you, and that cuts both ways. Look before writing it:

```sh
static-x <tool> --project . --format json | grep -c '"name": "<the-name>"'
```

Silencing 24 at once is right when all 24 are the same false positive — a product
name in prose, say. It is wrong for a short or common identifier: `"x"` matches 7
unrelated findings here, and some of them may be real. If the name is generic,
fix the comment instead of ignoring it.

Say the count in the commit body. An `ignore` entry is a claim that the tool is
wrong that many times over, and the next person needs to be able to check it.

**Leave it.** You do not understand the code well enough to be sure, or the fix
is a design decision (where should the shared helper live? is this duplication
deliberate?). Leave it in the baseline and move on. A wrong "fix" costs more than
an unfixed finding.

## Rules

- **Never run `static-x baseline` during the loop.** `baseline` *accepts*
  whatever it finds; `ratchet` *only tightens*. If ratchet refuses because
  something regressed, you broke something — fix it or revert it. Re-baselining
  would launder the regression into the record, which is the one failure this
  whole design exists to prevent.
- **Never `git commit --no-verify`.** The hook is the point.
- **Never widen `ignore` to silence a finding you believe is real.** That is the
  same laundering by another route.
- **`todo` already excludes what an agent should not touch** — dead exports
  (deleting one may remove public API no test covers) and comment-length
  thresholds (taste). Do not go looking for them with `--all` and fix them.
- **Stop and report** if the same finding survives two fix attempts, or if
  typecheck/tests fail in a way you did not cause.

## Reporting

After each iteration say: the file, how many findings, how many fixed vs ignored
vs left, and the baseline count before and after. `ratchet` prints the last one.

If you ignored anything, say which and why in the commit body — an `ignore` entry
is a claim that the tool is wrong, and the next person needs to be able to check it.
