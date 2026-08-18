# Swift roadmap

What a second shipping language pack costs, what sourcekit-lsp actually gives us, and what to build
first. Everything below was measured against **Swift 6.3.3** (`swiftlang-6.3.3.1.3`) on macOS during
the investigation that produced [`swift/`](../swift/README.md); nothing here is inferred from
documentation.

The [GDScript roadmap](gdscript-roadmap.md) is the model for this document, and the contrast with it
is the most useful thing in it: nearly every obstacle that stopped `gd/` from shipping code is absent
here, and it took measuring to know that rather than assuming it either way.

---

## 1. The connection is cheap, and there is no trap in it

```sh
sourcekit-lsp                       # stdio; no flags needed for SwiftPM
```

`--help` lists no transport option at all — no port, no `--path`. The project is selected by
`initialize`'s `rootUri`, and that is the **only** thing that selects it.

That last sentence is why gd's most expensive failure has no analogue here. Godot's trap needed two
ingredients: a shared TCP port, so a client could silently reach a *different* editor serving a
different project; and a project chosen by `--path` while `rootUri` was merely advisory, so the two
could disagree. sourcekit-lsp is stdio, so the connection reaches the process this pack spawned and
no other — there is no port to collide on and no pre-existing instance to reach by accident. And
`rootUri` cannot disagree with a flag that does not exist.

`core/lsp/client.ts` therefore needs **no transport seam**. The `{reader, writer}` refactor
`gd/server/README.md` prescribes stays undone until `gd/` is actually built; a seam with one
implementation is a guess.

### Capabilities, measured

Present and advertised: `semanticTokensProvider` (full + range), `documentSymbolProvider`,
`hoverProvider`, `definitionProvider`, `declarationProvider`, `referencesProvider`, `renameProvider`,
`completionProvider`, `workspaceSymbolProvider`, `codeActionProvider`, `documentFormattingProvider`,
`callHierarchyProvider`, `typeHierarchyProvider`, `implementationProvider`, `codeLensProvider`,
`colorProvider`, `documentHighlightProvider`.

There is **no `--version` flag**; `swift --version` is the only way to record which toolchain
answered, and nothing should gate on it.

---

## 2. The obstacle that was expected, and is not there

The comment family needs comment ranges, and the hazard is the one `ts/comments/collect.ts` exists to
avoid: a `//` inside a string is not a comment. `gd/`'s roadmap concluded that this family needs a
real AST and that GDScript has none, which is why it has no `comments/` directory.

Swift does have one, and it is already inside the server. Measured on a **bare directory with no
`Package.swift`, no `.xcodeproj`, and no build**, `textDocument/semanticTokens/full` returned in
**52ms**:

| Source | Reported as |
| --- | --- |
| `/// A doc line comment.` | `comment` + `documentation` |
| `// A plain line comment.` | `comment` |
| `/** A doc block comment. */` | `comment` + `documentation` |
| `/* A plain block comment. */` | `comment` |
| `"// not a comment"` | `string` |
| `#"raw // still not a comment"#` | `string` |
| `"Hello \(name) /* nor this */"` | `string` |

Three things follow, and each removed work from the plan:

- **No hand-written lexer.** A Swift comment lexer has to handle nesting block comments, `"""`
  literals, raw strings with matched pound counts, and `\(…)` interpolation that can itself contain
  strings and comments. The server does all of it, because it is SwiftSyntax.
- **The doc/non-doc flag is free.** `documentation` is a standard token modifier and sourcekit-lsp
  sets it. That flag is what stops every ordinary DocC summary from being read as narration; deriving
  it from the text would have worked, but this is the compiler's own answer.
- **No build is required.** Semantic tokens are syntactic. A project that has never been built, and a
  directory that is not a project at all, both answer.

---

## 3. What it costs

Measured over **H** = `hotseat-app` (204 files, SwiftPM), **D** = `drum/ios` (82 files, Xcode, no
`buildServer.json`), **W** = `thirdparty/War` (393 files, Xcode). `--scratch-path` pointed away from
each project's own build directory.

| | `initialize` | whole-project sweep | median/file | p95/file |
| --- | ---: | ---: | ---: | ---: |
| H, cold | 530ms | 724ms | 2ms | 8ms |
| H, warm | 270ms | 665ms | 2ms | 8ms |
| D | 27ms | 68s | 71ms | 4.7s |
| W | 28ms | 39s | 89ms | 107ms |

**A `commit` hook over ten changed files in H costs 380ms**, `initialize` included. That is the
number that makes Swift check suites a real feature rather than a nominal one, and it is the question
`gd/`'s roadmap left open and could not answer favourably — a Godot editor needs 12–40s to reach the
same point.

**Per-file latency is bimodal, and the slow mode is a window rather than a state.** The 2ms median
above is what a settled server answers. While sourcekit-lsp is doing background work after first
contact with a project, the same 204-file sweep measured **73s, median 210ms, p95 8s** — repeatedly,
on an idle machine, with no stray processes. Wiping the scratch path returned it to 742ms, and a
*completed* `swift build` into that scratch was fast again (812ms), so this is neither "cold" nor
"has an index": it is the indexing window itself. A whole-project run can therefore cost 0.8s or 73s
depending on when it lands, which is worth knowing before quoting either number, and is a real part
of the case for [the daemon](../swift/daemon/README.md) — a warm session rides through the window
once instead of meeting it on every invocation.

**The cost that is real is Xcode without `buildServer.json`.** Per-file latency is 35–70× SwiftPM's,
and D's p95 of 4.7s says the tail is much worse than the median. Zero requests failed and comments
were found throughout, so this is latency rather than a capability gap — sourcekit-lsp appears to
attempt build-settings resolution per file and fall back after waiting. Two consequences: a
whole-project `push` or `baseline` run on an Xcode project takes tens of seconds, and
`xcode-build-server` is worth recommending in `swift/README.md` rather than treating as exotic.

---

## 4. What to build, in order

1. **`swift/server` + `swift/project` + `swift/ferry`.** A session that binds, caches per root, and
   serializes. Needs one change in `core`: `LspClient.initialize` must accept extra client
   capabilities, because omitting `textDocument.semanticTokens` makes the server return `null` —
   which is indistinguishable from "unsupported".
2. **`swift/daemon`.** Kept after §3 rather than because of it: startup is not the cost, so its
   argument is the `(path, mtime)` memo across repeat runs and the Xcode per-file tail. Its README
   must say that, not claim it amortizes a startup that measures 0.3s.
3. **`swift/comments/long` and `swift/comments/llm-tells`.** Cheap, syntactic, no build.
4. **`swift/comments/stale-refs`.** Shipped. Resolution needs no build: semantic tokens for the
   project's own names, string literals for the vocabulary comments actually quote, and a committed
   19,923-name index generated from `swift-symbolgraph-extract` for the SDK.

---

## 5. Open questions

**Does the block/warn split port?** `ts/checks.ts` measures its split against this repository. There
is no Swift here, so the split is measured on three projects by two authors — the same gap
`gd/`'s roadmap flagged, and it should be read as a weaker warrant than TypeScript's, not an equal
one.

**Is `Tests/` different enough to want its own defaults?** It is in `sourceFiles()` on the argument
that a hook ignoring test code lets the model write bad test code. If a tool turns out to report
mostly from `Tests/`, the fix is that tool's default `ignore`, not the file set.

**What does `buildServer.json` actually buy?** §3 measures Xcode-without-it. Nobody has measured
Xcode-with-it, and the answer decides whether the pack should recommend `xcode-build-server` or
require it for anything beyond the syntactic tools.

**Does the guard port, if refactorings are ever wanted?** Unmeasured. `gd/`'s answer was no, for a
reason specific to its architecture (cross-file resolution runs against the server's index rather
than the client's buffers). Whether sourcekit-lsp behaves the same way is the first thing to probe
before anyone plans a Swift refactoring.

---

## 6. What this does not cover

**One machine, one toolchain, one platform.** Swift 6.3.3 on macOS with Xcode. Linux has no `xcrun`
and no `.xcodeproj`, and none of it was measured there.

**Three corpora, two authors, and only one of them SwiftPM.** The timings that make the case for
cheap check suites come from H alone; both Xcode projects are 35–70× slower per file, and if most
real Swift projects are Xcode projects then §3's headline number is the exception rather than the
rule. Nothing here should be quoted without the build system attached.

**Nothing about semantic requests.** Everything measured is syntactic — semantic tokens and, by
inference, `documentSymbol`. The moment a tool needs `references` or `workspace/symbol` it needs an
index store, which needs a build, and none of that has been measured.
