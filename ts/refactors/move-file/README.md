# ts/refactors/move-file

Moves a file to a new path and rewrites every module specifier that resolves to it, together with the relative specifiers the file itself writes. In C# a folder and a namespace are linked only by convention, so moving a file is a filesystem operation with an optional namespace fixup after it; in TypeScript a module specifier *is* a path, so the new location is already written into every importer and into every relative import the moved file makes. The rewrite is not a cleanup pass, it is the move. The compiler computes both halves (`getEditsForFileRename`), and the tool packages them with the rename as one `WorkspaceEdit` — the rename rides in `edit.fileOps`, and the moved file's own edits are keyed by its **new** path, the tree the edit produces.

TypeScript rewrites the project's `tsconfig.json` in the same pass where it can: `files`/`include` entries and `paths` mappings that name the file outright. Those edits are part of the returned `WorkspaceEdit`.

Both ends of the move are paths, so nothing has to be located inside a file — there is no caret to place, no symbol to disambiguate, and no ambiguity to report.

**Dry-run by default.** Without `apply: true` the tool returns the `WorkspaceEdit` and moves nothing.

**Refuses** when the destination already exists (moving onto it would destroy it), when the destination is outside the project root, when source and destination are the same path, and when the file is not one the project compiles.

**Diagnostic guard.** Before writing, the project is typechecked in memory with the move applied — the moved file entering the compilation at its new path and leaving it at the old one — so a specifier the rewrite missed, on either side, shows up. Anything introduced is returned in `newDiagnostics` and the move is refused, even with `apply: true`. The typecheck resolves modules through the real filesystem, so a destination folder that does not exist yet is created empty before the check and removed again unless the move is applied; without it every specifier pointing into the new folder would look unresolvable.

**Case-only renames.** `Widget.ts` → `widget.ts` is a real move that a case-insensitive filesystem cannot represent: the two spellings name one file, so the destination "exists" before the move and the in-memory typecheck sees the file under both names at once. The existence check is skipped, the resulting casing conflicts (TS1149, TS1261) are reported as a warning rather than counted against the edit, and the write goes through a temporary path so the content survives.

**Warnings** name references to the old path that no compiler reads. All of them keep typechecking and break at run time: `package.json` `main`/`module`/`types`/`bin`/`exports` entries pointing at the moved file (matched the way `ts/graph/dead-exports` matches them, so a built `dist/index.js` counts as naming the source under `src/`); wildcard `paths` aliases whose subtree the file has left, which TypeScript cannot rewrite the way it rewrites an exact one; and root-level `*.config.*` files naming the file outright. A warning never blocks the move.

## Input

| Option | Meaning |
| --- | --- |
| `file` | The file to move, project-relative or absolute (required) |
| `toFile` | Full destination path, project-relative or absolute |
| `toDirectory` | Destination folder; the file keeps its name |
| `apply` | Write to disk (default `false`) |

Exactly one of `toFile` / `toDirectory` is required.

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings }` — `edit.changes` is keyed by post-move paths and `edit.fileOps` carries the `rename`.

```sh
static-x ts/refactors/move-file --project path/to/project \
  --input '{"file": "src/lib.ts", "toDirectory": "src/core", "apply": true}'
```

([Install instructions](../../../README.md#install).)
