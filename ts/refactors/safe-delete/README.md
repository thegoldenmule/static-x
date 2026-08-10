# ts/refactors/safe-delete

Deletes a declaration only after proving that nothing references it, and removes what the deletion orphans: the leading JSDoc, the import specifiers that bound the name in other files, the barrel `export { X } from './x.js'` lines that re-exported it, and any file left without a statement. This is the removal half of [`ts/graph/dead-exports`](../../graph/dead-exports/README.md) — that tool finds what nothing imports, this one takes it out.

Deletability is decided by classifying every reference the language service reports, not by counting them. A declaration is removable when each reference is the declaration itself, an import binding, or a re-export specifier; anything else — a call, a read, a write, a type annotation, a value handed to something — is a live use, and the deletion is refused with each site named. References inside the declaration being deleted (a recursive call, a method naming its own class) go with it rather than blocking it. `ReferenceEntry.isWriteAccess` is never consulted: it reports true for declarations and import specifiers, so a tool built on it refuses code it could delete.

**Dry-run by default.** Without `apply: true` the tool returns the `WorkspaceEdit`, the classified references, and the blind spots, and touches nothing.

**The typecheck guard is at its strongest here.** Before writing, the project is typechecked in memory with the edit applied, files it deletes excluded. A reference this tool missed does not become a subtle shape change; it becomes a hard `TS2304: Cannot find name`. Anything introduced lands in `newDiagnostics` and the deletion is refused even with `apply: true`.

**But the guard cannot see the failure that matters,** because a deletion's failure mode is code that still compiles and no longer works. `blindSpots` names the reference forms TypeScript never resolves, on every run, whether or not the guard is clean: string-keyed access (`registry['handlerName']`, a command name off the wire, a key in a config file) — with the literal sites listed when the deleted name appears as a string anywhere in the project; dependency-injection containers, decorator metadata, and reflection, which bind by token or emitted type; framework file-name conventions; and paths in `package.json`. Deleting an **exported** symbol gets a louder note than a file-local one, because an export is API for code this project cannot compile. A clean `applied: true` is never on its own proof that a deletion was safe.

**Package entry points are refused, not warned about.** A symbol exported from a file that any `package.json` under the root names in `main`, `module`, `types`, `bin`, or `exports` is public API by definition; the refusal names the field and the target. The field set and the source-file matching are `ts/graph/dead-exports`'s, whose exemptions were validated against real projects.

**Files are only removed when nothing still imports them.** A file the deletion empties is deleted — but `import './x.js'` and `export * from './x.js'` name no symbol, so no reference analysis can see them, and the guard's overlay keeps a deleted file resolvable, which means a side-effect import of it typechecks in memory and breaks on disk. The import graph answers that question instead: an emptied file with a surviving importer is left in place, empty, with a warning naming the importer.

**Tests are not a reason to keep a symbol.** By default a reference from `*.test.ts` / `*.spec.ts` is not a use — the tests of a dead symbol are dead too — so their import bindings are removed with it, and a test file left with no statements goes as well. `includeTests: true` reverses that: any reference from a test keeps the symbol alive and the deletion is refused. Removing an `it(...)` or `describe(...)` block is out of scope in either mode; when a test does more than import the symbol, the deletion is refused and says so.

**Refused outright:** parameters (removing one rewrites a signature and every call site — that is `ts/refactors/change-signature`, not yet built); members of an interface, type literal, or enum (a change to a type's shape); one binder of a multi-declarator `const`; a symbol with more than one declaration (overloads, declaration merges); and a class member that any supertype or subtype also declares, since deleting it changes which implementation runs without changing what compiles. A class whose hierarchy cannot be resolved — a mixin — is refused rather than assumed empty.

## Input

| Option | Default | Meaning |
| --- | --- | --- |
| `symbol` | — | Target a declaration by name; errors with candidate locations if ambiguous across files |
| `file`, `line`, `character` | — | Target an exact position (zero-based); `file` alone also disambiguates `symbol` |
| `includeTests` | `false` | Treat references from test files as uses that block the deletion |
| `apply` | `false` | Write the edit to disk |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, references, blindSpots }` — `edit` is an LSP-compatible `WorkspaceEdit` keyed by absolute path, with a `delete` file operation for each file the deletion empties; `references` is every reference found, as `{ file, line, character, kind }`; `warnings` reports what the edit did beyond the named declaration (files removed, test bindings dropped, emptied files kept); `blindSpots` is what no part of this could check. A refusal throws with the blocking references listed.

```sh
static-x ts/refactors/safe-delete --project path/to/project \
  --input '{"symbol": "formatLabel", "apply": true}'
```

([Install instructions](../../../README.md#install).)
