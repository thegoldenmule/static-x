# server

Finds sourcekit-lsp and completes the handshake. The counterpart of [`ts/server`](../../ts/server/spawn.ts).

## Finding the binary

In order: `static-x.json`'s `swift.serverPath`, then `xcrun --find sourcekit-lsp`, then `PATH`, then
throw naming all three. A project pinned to a particular toolchain has to be able to say so, because
`xcode-select` and `DEVELOPER_DIR` are machine-global state that a repository cannot control.

Never hardcode `/Applications/Xcode.app/...`. And note there is **no `--version` flag** — `swift
--version` is the only way to record which toolchain answered, and nothing should gate on it.

## The handshake declares more than `core/lsp` does by default

`textDocument.semanticTokens` has to be declared, and omitting it fails in the worst available way:
`semanticTokens/full` returns `null`, which is exactly what an unsupported request returns. The
comment family would report nothing, correctly-looking, forever. That is why
`LspClient.initialize` grew an optional capabilities parameter rather than each pack rebuilding the
blob.

Also declared: `window.workDoneProgress`, and
`textDocument.documentSymbol.hierarchicalDocumentSymbolSupport`.

## The handshake guard asserts only what ships

`semanticTokensProvider`, `documentSymbolProvider`, `hoverProvider`. Nothing more — asserting a
capability no shipped tool consumes turns a working session into a hard failure for no benefit. Each
assertion arrives with the tool that needs it.

That is `gd/`'s lesson restated: the capability list is not what proves a session usable. Godot's
wrong-project instance advertised every capability and then answered nothing correctly.

## The hazard that does *not* exist here, and the one that does

**Not here: reaching the wrong project.** Godot's trap needed a shared TCP port and a project
selected by a flag while `rootUri` was advisory. sourcekit-lsp is stdio, so the connection reaches
the process this pack spawned and no other, and `rootUri` is the only thing that selects the project.
There is nothing to collide on. This is a real saving and it is why `core/lsp/client.ts` needs no
transport seam.

**Here: answering without build settings.** sourcekit-lsp will answer for a file it has no build
settings for, by parsing it with no module context. The answers are not empty and not obviously
wrong — they are simply missing everything cross-file. For the syntactic tools this pack ships that
is harmless and is in fact the property being relied on. For anything semantic it is
[the thing to guard](../../docs/swift-roadmap.md#5-open-questions), with a positive control that only
a resolved build could pass — and that guard should not be written before it is measured.
