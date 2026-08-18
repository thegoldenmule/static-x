# Swift tools

The Swift language pack, built on [sourcekit-lsp](https://github.com/swiftlang/sourcekit-lsp). The
[roadmap](../docs/swift-roadmap.md) is the measured argument for what goes in it and in what order.

| Tool | Description |
| --- | --- |
| [`swift/comments/long`](comments/long/README.md) | Comment blocks past a line or character threshold |
| [`swift/comments/llm-tells`](comments/llm-tells/README.md) | Comments with the hallmarks of generated text |

[`swift/comments/stale-refs`](comments/stale-refs/README.md) is designed and measured but not built;
its README carries both.

## What binds this pack to a project

`ts/` binds to two views — a language server and a `ts.Program` — and the second is what makes its
mutating tools possible, because it can be handed an overlay and asked to typecheck. Swift has one
view: a sourcekit-lsp process over stdio.

That turned out to be less of a constraint than `gd/`'s single view, for a reason worth stating
plainly: **sourcekit-lsp answers syntactic requests without a build, and does it in milliseconds.**
Measured on a 204-file SwiftPM project, `initialize` takes 530ms cold and the whole project's
semantic tokens take another 724ms. A directory with no `Package.swift` at all still answers.

So the analysis this pack ships needs no compiled index, no `swift build`, and no manifest — which is
what makes a Swift pre-commit hook affordable at all.

## What it costs on an Xcode project

The number above is SwiftPM's. Without a `buildServer.json`, an Xcode project costs 35–70× more per
file: `drum/ios` at 82 files takes 68 seconds to sweep, with a p95 of 4.7s per file against SwiftPM's
8ms. Nothing fails and every comment is still found, so this is latency rather than a missing
capability — sourcekit-lsp appears to attempt per-file build-settings resolution and give up after
waiting.

`xcode-build-server` writes the `buildServer.json` that removes the guesswork. Whether it removes the
latency is [unmeasured](../docs/swift-roadmap.md#5-open-questions), and until someone measures it,
this pack should not claim otherwise.

## Layout

- `server/` — finds sourcekit-lsp and completes the handshake
- `project/` — binds to a project on disk, and the file sets analysis reports in
- `daemon/` — keeps a session warm between runs
- `ferry/` — dispatch: one cached session per project root, calls serialized
- `comments/` — the comment family, reading ranges from the server's semantic tokens

Each carries a README stating what it is for and what is known about it.
