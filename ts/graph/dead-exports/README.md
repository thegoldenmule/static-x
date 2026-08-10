# ts/graph/dead-exports

Finds exported symbols nothing in the project imports (`graph.dead-export`) and files nothing imports (`graph.dead-file`), from one pass over the project's resolved module graph. A dead file produces a single finding; its exports are not also flagged individually.

Import edges are resolved with the compiler's own module resolution using the project's real compiler options, so tsconfig `paths` aliases, re-export chains through entry points, dynamic `import()` calls with literal specifiers, `import x = require(...)`, and bare `require('./x')` calls (CommonJS sources under `allowJs`) all count as consumption. A namespace import (`import * as ns`), star re-export, or dynamic import consumes every export of its target. Dead value exports (functions, classes, consts, enums) are warnings at high confidence; dead type-only exports (interfaces, type aliases) are info at medium confidence, since types are commonly exported for downstream annotation.

Entry-point detection walks every `package.json` under the project root (monorepo workspaces included) and exempts files referenced from `main`, `module`, `types`, `bin`, or any `exports` target; as a heuristic, a built target like `dist/index.js` or `dist/index.d.ts` also exempts the same-named file under that package's `src/`. A target that exists on disk but is not program source — a `.mjs` bin shim that registers a loader and imports the real entry, say — is scanned one level deep, and the project files it imports (including through `import(new URL('./main.ts', import.meta.url))`) are exempt too. A file with no imports or exports at all is a script, not a module; nothing can import it, but its declarations are ambient globals the graph cannot see, so its dead-file finding drops to `info` severity at `low` confidence. `extraRoots` extends consumption to sibling projects scanned syntactically: names imported anywhere in an extra root count as consumed project-wide (name matching, no resolution — conservative by design), and a namespace import naming the analyzed package consumes everything. Providing `extraRoots` drops value-export confidence to `medium`.

**Exempt:** package entry points, framework-convention files (`app/`/`pages/` special files, `middleware.ts`, `instrumentation.ts`, `*.config.ts` / `*.config.mts`), files matched by `entryPoints` globs, and test files' own exports (test runners load them directly; they still count as consumers). Files under hidden directories (generated output like `.next/types`) are never audited at all — the project session excludes them from analysis — but their imports still count as consumption, so a file referenced only from generated code is not reported dead.

## Input

| Option | Default | Meaning |
| --- | --- | --- |
| `entryPoints` | `[]` | Globs relative to the project root (`*` and `**`) naming additional entry-point files whose exports are exempt |
| `extraRoots` | `[]` | Additional consumer roots (e.g. sibling monorepo packages) scanned syntactically for imported names |

## Output

`Finding[]` with code `graph.dead-export` (range on the exported name) or `graph.dead-file` (range covering the file's first line), and `data: { name, kind, confidence, importersOfFile }` where `kind` is `value`, `type`, or `file`.

```sh
static-x ts/graph/dead-exports --project path/to/project --input '{"entryPoints": ["scripts/**"]}'
```

([Install instructions](../../../README.md#install).)
