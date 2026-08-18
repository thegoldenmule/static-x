# project

Binds to one Swift project on disk and owns the file sets tools read through — the counterpart of
[`ts/project`](../../ts/project/session.ts).

## Binding, in precedence order

Root only. Never recursive, and never walking up past the root — the same rule
`TsProjectSession.open` enforces with `startsWith(absRoot + sep)`.

1. **`buildServer.json`** — it exists only because someone deliberately configured how this project
   builds, and explicit configuration beats every inference.
2. **`Package.swift`** — SwiftPM. The highest-confidence automatic binding, and it beats a
   co-located `.xcodeproj`, which is usually generated from it.
3. **`compile_commands.json`** — a compilation database is a complete answer for the files it lists.
4. **`*.xcworkspace`, then `*.xcodeproj`** — lowest. A workspace containing a project is the outer
   truth, which is the shape CocoaPods produces.

Recursion is not a stylistic choice. `thirdparty/War` has `War.xcodeproj` at its root and a vendored
`sdk-swift5-ios/Package.swift` several directories down; a recursive search finds the vendored SDK
and binds the wrong project.

`binds()` and `open()` call the same discovery function, so they cannot drift and offer a tool that
then fails to bind — the discipline `hooks.test.ts` already enforces byte-for-byte elsewhere.

## The file sets

`ts/project` distinguishes four and calls picking the wrong one a real defect. The same four apply,
with one structural difference worth stating: `ts.Program` hands TypeScript its file sets, and
sourcekit-lsp has no equivalent request. Swift's sets come from a filesystem walk — cheap, needing no
session, and **not authoritative about what the build includes**.

- **`projectFiles()`** — every `.swift` under the root, vendored directories included. A reference
  *from* `Pods/` into project code is still a reference.
- **`sourceFiles()`** — what analysis reports in. Excludes `.build/`, `.swiftpm/`, `DerivedData/`,
  `Pods/`, `Carthage/`, and any hidden segment. `Pods/` and `Carthage/` are the direct analogue of
  `gd/`'s `addons/`: vendored third-party source, not the author's to fix.
- **`compilationFiles()`** — the blast radius, deliberately not narrowed to the root.
- **`targetFiles()`** — `sourceFiles()` narrowed by the caller's `files` scope.

`Package.swift` and `Package@swift-*.swift` are excluded from every set. They are `.swift` files that
belong to no target, compiled against `PackageDescription`; a finding in one is noise.

**`Tests/` stays in `sourceFiles()`.** It is the author's committed code, and a Claude Code hook that
ignores test files is a hook that lets the model write bad tests. If a tool turns out to report mostly
from `Tests/`, the fix is that tool's default `ignore`, not a different file set.

## Why `compilationFiles()` is not narrowed, restated for Swift

In TypeScript the reason is that a tsconfig can `include` a sibling directory. In Swift the reason is
sharper: the unit is the **module**, not the directory. An `internal` symbol's callers live anywhere
in its own target, a `public` symbol's callers live in sibling targets, and — the part with no
TypeScript analogue — **Swift has no per-file import for same-module symbols**, so a file's
dependents are not discoverable from its own text at all.

Module membership is not exposed by any LSP request. Until a tool needs it, `compilationFiles()`
returns `projectFiles()` and `modules()` stays undefined. Inventing module resolution before
something requires it would be inventing a seam with no consumer.
