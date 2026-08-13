# server

Launches Godot headless and completes the LSP handshake. The counterpart of
[`ts/server`](../../ts/server/spawn.ts), and different from it in three ways that are not incidental.

## The transport is TCP

`ts/server` spawns a process with piped stdio and hands the streams to `LspClient`. Godot's language
server does not speak stdio at all; it listens on a TCP socket. `core/lsp/client.ts` currently takes a
`ChildProcess` in its constructor and reads `child.stdout` / `child.stdin`, so it cannot be reused as
written — the protocol half of it is exactly right, the transport half is hardwired.

The change that makes it reusable is small and belongs in `core/`, not here: take a
`{ reader, writer }` pair rather than a child process, and let each pack supply it. `LspClient` also
uses the child for `shutdown()`'s force-kill fallback, which a TCP pack still needs — the process
handle and the message streams stop being the same thing.

## The launch is not free, and it is not quiet

```sh
godot --headless --editor --lsp-port <port> --path <project>
```

`--headless` alone will not do: the language server is part of the editor, so `--editor` is required.
The engine binary is found by platform convention or configuration; on macOS the app bundle puts it at
`/Applications/Godot.app/Contents/MacOS/Godot`.

Startup is measured in seconds, not milliseconds — the editor scans the filesystem, imports resources,
and registers global classes before it answers anything. Roughly 12s for a 7-file fixture and 40s for
a 203-file project on this machine. This is the strongest argument for the
[`ferry`](../ferry/README.md) session cache the TypeScript pack already has, and it makes a
per-invocation launch untenable for a hook.

## A taken port fails silently, and the failure looks like success

This is the hazard to design against, and it cost a full round of wrong measurements while
investigating.

A second Godot instance started on a port another editor already holds **does not error and does not
exit**. It runs, it logs nothing about the port, and it simply never listens. A client connecting to
that port reaches *the other editor* — a different project entirely — and gets fluent, plausible,
completely wrong answers: hovers describing methods from another codebase, references that come back
empty, renames that return `{"changes": {}}`.

The default port is 6005, and a developer with the Godot editor open is already using it.

Three things the server layer must therefore do:

1. **Choose a port by binding it first.** Ask the OS for a free port and hand that number to
   `--lsp-port`, rather than picking a default and hoping.
2. **Verify the connection reached the instance it started.** The server sends a
   `gdscript_client/changeWorkspace` notification naming the project it is actually serving. If that
   path is not the root that was requested, the session is wrong and must fail loudly rather than
   answer. The server also sends `window/showMessage` with *"The GDScript Language Server might not
   work correctly with other projects than the one opened in Godot"* — which is the engine noticing
   the same thing and being far too polite about it.
3. **Treat `rootUri` as advisory.** The project is selected by `--path`. The `initialize` `rootUri`
   does not override it and does not cause an error when it disagrees.

## What `initialize` reports, and what that is worth

Measured against 4.7.1 — worth re-measuring per version rather than trusting:

```
completionProvider   declarationProvider   definitionProvider   documentHighlightProvider
documentLinkProvider documentSymbolProvider hoverProvider       referencesProvider
renameProvider{prepareProvider} signatureHelpProvider  textDocumentSync{change:1 = Full}
```

and, reported false or absent: `codeActionProvider`, `documentFormattingProvider`,
`documentRangeFormattingProvider`, `foldingRangeProvider`, `implementationProvider`,
`typeDefinitionProvider`, `workspaceSymbolProvider`. `workspace/symbol`,
`textDocument/codeAction` and `textDocument/formatting` return *Method not found* when called anyway.

`ts/server` guards its handshake by asserting the capabilities it needs are present. The equivalent
guard here should assert `referencesProvider` and `renameProvider` — but note that the capability
list is not what proves the session is usable. Everything above was advertised identically by the
wrong-project instance, which then answered nothing correctly. The workspace check in point 2 is the
one that matters.
