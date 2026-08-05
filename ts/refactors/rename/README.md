# ts/refactors/rename

Renames a symbol across the whole project through the language server (`prepareRename` → `rename`), so every reference — imports, re-exports, property accesses, JSX — moves together. Shorthand properties expand correctly: renaming the property `retries` turns `{ retries }` into `{ attempts: retries }`, leaving the local variable alone.

**Dry-run by default.** Without `apply: true` the tool returns the `WorkspaceEdit` and touches nothing.

**Collision guard.** Before writing, the project is typechecked in memory with the edit applied. Any diagnostics that would be introduced (duplicate identifiers, broken references) are returned in `newDiagnostics` and the rename is refused — even with `apply: true`.

## Input

| Option | Meaning |
| --- | --- |
| `newName` | The new identifier (required) |
| `symbol` | Target a declaration by name; errors with candidate locations if ambiguous across files |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics }` — `edit` is an LSP-compatible `WorkspaceEdit` keyed by absolute file path.

```sh
npm run sx -- ts/refactors/rename --project path/to/project \
  --input '{"symbol": "makeOptions", "newName": "buildOptions", "apply": true}'
```
