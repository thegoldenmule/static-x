# ts/comments/stale-refs

Finds comments that reference code that doesn't exist — the comment survived a refactor the code didn't.

## How it works

1. **Extract** candidate references from each comment: `@param` names, `@see` and `{@link}` targets, backtick code spans, filename tokens (`ref-set-sugar.test.ts` — hyphen-aware, extracted whole), and bare prose tokens shaped like code (a case hump, underscore, dot chain, or call parens — `LegacyGreeter`, `foo.bar`, `load_config`, `greet()`).
2. **Resolve** each candidate against everything that counts as existing:
   - symbols in scope at the comment's position (locals, imports, and globals like `JSON`), via the type checker;
   - a project-wide index of declaration names **and string-literal vocabulary** — discriminated-union tags (`op: "addElement"`), event-type strings, sentinel values (`"$ordinal"`), and object-literal keys, since comments name these constantly and no identifier declaration ever will;
   - TypeScript keywords (`` `never` ``, `` `string` ``) and members of the standard builtins (`toISOString()`, `sort()`);
   - for filename tokens, the project's real files (sources plus a root listing);
   - optionally, names parsed from `extraRoots` (see below).

   A dotted chain counts as resolved if any segment resolves.
3. **Flag** what's left. `@param` names are validated structurally against the documented function's real parameter list.

## Input

| Option | Meaning |
| --- | --- |
| `extraRoots` | Additional roots (sibling monorepo packages) whose declared and literal names count as existing; relative paths resolve against the project root. Syntax-only parse — cheap. |

## Output

`Finding[]` — `comment.stale-param` (severity `warning`) for parameter-tag mismatches, `comment.stale-ref` for everything else. `data` carries the unresolved `name`, the extraction `source` (`param-tag` / `jsdoc-tag` / `code-span` / `bare`), and a `confidence` of `high` (param tags), `medium` (JSDoc tags, code spans), or `low` (bare prose, severity `info`) so consumers can choose what to act on. Ranges point at the reference inside the comment, not the whole comment.

```sh
static-x ts/comments/stale-refs --project path/to/project
```

([Install instructions](../../../README.md#install).)
