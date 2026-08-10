# ts/refactors/move-symbol

Moves a top-level declaration out of its file into another file — existing, or created on the spot — through TypeScript's own move engine. The declaration gains an `export` if it did not have one, the names its body depends on are exported from the old file and imported into the new one, the old file imports back anything it still uses, and every importer's module specifier is rewritten. In TypeScript the module *is* the file, so there is no separate "move to another namespace/module": changing a symbol's module means moving its declaration, which is this tool.

Targeting is by declaration name (`symbol`) or exact position, and the whole top-level statement moves — a caret is not a selection, so the tool widens the target to the statement TypeScript can actually address, and refuses a target that is not one (a class member, a nested function). Omit `toFile` and TypeScript names a new file after the symbol beside the source; the existing files it would have offered come back in `destinationSuggestions`, so the next call can name one.

**Dry-run by default.** Without `apply: true` the tool returns the `WorkspaceEdit` — file creations included, as `fileOps` — and touches nothing.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied, the created file included in the compilation. Anything the move would break is returned in `newDiagnostics` and the move is refused, even with `apply: true`. This is not theoretical: TypeScript's usage analysis skips locals bound by a top-level destructuring (`const { round } = Math`), so a moved function that calls one lands in a file where that name is unbound, and the guard catches the `TS2304` the engine would otherwise have written to disk.

**Barrel re-exports are redirected.** A re-export (`export { X } from './old.js'`) is not an import of `X` into anything and no file moved, so the engine leaves it pointing at a module that no longer declares the symbol — a `TS2459`/`TS2305` that would refuse the move outright. Re-exports resolving to the source file are rewritten here instead: the specifier alone when the statement names only moved symbols, otherwise the statement splits so the names that stayed keep the old specifier. An `export * from './old.js'` names nothing to redirect and quietly stops carrying the symbol, so it is reported in `warnings` rather than rewritten.

**Refusals.** A destination directory that does not exist yet is refused: module resolution probes the real filesystem, so every rewritten importer would fail the guard with a spurious `TS2307`. Moving into a file that already imports the symbol normally works — the engine drops that import as the declaration arrives — but when the moved code also needs a *new* import from the same module, the engine has to delete and extend one import statement at once and asserts its way out with `Changes overlap`; that failure is translated into a message naming the destination rather than surfaced as an internal error.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Target a declaration by name; errors with candidate locations if ambiguous across files |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `toFile` | Destination file, existing or to be created, relative to the project root; omit to let TypeScript name a new file |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, created, destinationSuggestions }` — `edit` is an LSP-compatible `WorkspaceEdit` keyed by absolute path, with a `create` file operation for a file the move brings into existence; `created` lists those paths, and `destinationSuggestions` lists the existing files TypeScript would have offered (only when `toFile` was omitted).

```sh
static-x ts/refactors/move-symbol --project path/to/project \
  --input '{"symbol": "Shipment", "toFile": "src/shipment.ts", "apply": true}'
```

([Install instructions](../../../README.md#install).)
