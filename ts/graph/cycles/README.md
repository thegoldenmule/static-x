# ts/graph/cycles

Finds import cycles (`graph.cycle`) as strongly-connected components of the project's resolved module graph — one finding per component, so overlapping loops through the same files report as a single group rather than once per loop.

Import edges are resolved with the compiler's own module resolution using the project's real compiler options, so static imports, re-exports, dynamic `import()` calls with literal specifiers, `import x = require(...)`, bare `require('./x')` calls, and tsconfig `paths` aliases all contribute edges. A cycle with at least one value edge is a `warning`: value cycles make initialization order fragile and defeat tree-shaking. A cycle whose every edge is `import type` is `info`: erased at runtime and legal, but still structural debt. Break a cycle by extracting the shared piece into a module both sides import.

Each finding anchors on the cycle's lexicographically-first file, with the range on that file's first in-cycle import statement, and shows the shortest loop through the anchor. Files under hidden directories (generated output like `.next/types`) participate in the graph — a cycle through generated code is real at runtime — but are never the anchor: the finding lands on the first non-hidden member, and a cycle living entirely under hidden directories is not reported. When the component contains more files than the displayed loop, the message notes the size of the strongly-connected group. Output is deterministic for a given graph regardless of edge discovery order.

## Input

None — the tool takes no options.

## Output

`Finding[]` with code `graph.cycle`, one per cycle group, range on the anchor file's in-cycle import statement, and `data: { name, kind, files, size, typeOnly, confidence }` where `name` is the anchor's project-relative path, `kind` is `value` or `type-only`, `files` lists every member of the group sorted, and `typeOnly` marks cycles fully erased at runtime.

```sh
static-x ts/graph/cycles --project path/to/project
```

([Install instructions](../../../README.md#install).)
