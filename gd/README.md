# GDScript tools

The GDScript language pack. Nothing ships yet — this directory is the shape the pack will take, and
[the roadmap](../docs/gdscript-roadmap.md) is the measured argument for what goes in it and in which
order.

| Tool | Description |
| --- | --- |
| _(none yet)_ | |

## What binds this pack to a project

`ts/` binds to two views of a project — a language server and a `ts.Program` — and the second one is
what makes the mutating tools possible, because it can be handed an overlay and asked to typecheck.
GDScript has no second view. The compiler is inside the engine, there is no library form of it, and
everything reachable from outside arrives over one connection to a running Godot editor.

That connection is real, and better than the forum thread that prompted this suggests. Measured
against Godot **4.7.1.stable** on macOS:

```sh
godot --headless --editor --lsp-port 6011 --path <project>
```

serves LSP **over TCP**, not stdio. `--headless` alone does not — the language server lives in the
editor, so `--editor` is required and the two compose. What the server then does is measured in the
roadmap; the two facts that shape every design decision here are:

- **It indexes the whole project by itself.** A references request found a call site in a file the
  client had never sent `didOpen` for. Unlike tsserver, an analysis tool does not have to open the
  project to see it.
- **The in-memory guard is single-file.** `didChange` with modified text re-diagnoses that file and
  leaves disk alone, which is the [`diagnosticsIntroducedBy`](../ts/refactors/guard.ts) pattern
  exactly — but cross-file breakage is invisible, even if the dependent file is poked afterwards.
  Renaming a declaration in one buffer and leaving a caller dangling in another produced no
  diagnostic for the caller. So a mutating tool here cannot verify its own blast radius the way
  every mutating tool in `ts/` does.

The second one is why this pack starts with analysis and treats refactorings as a separate, harder
question rather than the reference shape.

## What the language server cannot see at all

Scenes. `.tscn` and `.tres` are where a Godot project keeps a large part of its wiring — which script
is attached to which node, which signal is connected to which method, which resource is loaded — and
the language server does not read them. This is not a gap to be sorry about; it is where the pack's
value is, because it is also invisible to the engine's own diagnostics.

The load-bearing measurement: renaming the signal `died` in `fixtures/basic-gd/player.gd` through the
language server rewrites the declaration and the `emit`, reports success, and leaves

```
[connection signal="died" from="Player" to="." method="_on_player_died"]
```

in `main.tscn` pointing at a signal that no longer exists. Nothing reports it. The game breaks at
runtime.

## Layout

- `server/` — launches Godot headless and completes the LSP handshake over TCP
- `project/` — binds to a project on disk: `project.godot`, `res://` and `uid://` resolution, and the
  file sets analysis reports in
- `ferry/` — dispatch, one cached session per project root, serialized calls
- `diagnostics/` — the engine's own errors and warnings, surfaced as `Finding[]`
- `graph/` — the resource graph: `preload`/`load`, scene `ext_resource`, autoloads, `plugin.cfg`
- `scene/` — what only a `.tscn`/`.tres` reader can check
- `refactors/` — deferred; see the roadmap for what the missing guard costs

Each of those directories carries a README stating what it is for and what is known about it.

## Fixture

`fixtures/basic-gd/` is a real Godot project — small, and every file in it earns its place by
exercising something measured. Its comments state what it demonstrates, and all of them were verified
against 4.7.1 rather than assumed:

| File | What it is for |
| --- | --- |
| `player.gd` | The signal `main.tscn` connects to, so rename's scene blindness is reproducible |
| `main.gd` | An error and a warning on one line, so severity separation has a case |
| `spawner.gd` | Referenced without ever being opened, so whole-project indexing has a case |
| `warnings.gd` | Five warnings, no errors |
| `parse_error.gd` | One error and, because of it, zero of the two warnings it also contains |
| `scripts/game_state.gd` | An autoload — referenced only by `project.godot` |
| `main.tscn` | A script attachment and a signal connection, neither visible to the server |

Running any tool against it regenerates `.godot/`, which is gitignored. The `.gd.uid` files are not
cache and stay committed: they are what `uid://` references in scenes resolve against.
