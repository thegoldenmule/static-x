# project

Binds to one Godot project on disk and owns the views tools read through — the counterpart of
[`ts/project`](../../ts/project/session.ts).

## One view, not three

`TsProjectSession` holds an LSP client, a `ts.LanguageService`, and a `ts.Program`, and the tools pick
whichever answers their question. A GDScript session has the language server and nothing else. There
is no library form of the GDScript compiler, so there is no second opinion to consult and no AST to
walk without adding a parser that is not the engine's.

What that costs is concentrated in one place: the engine's parser is the only thing that agrees with
the engine, and any second parser this pack adopts will disagree with it somewhere. See the roadmap's
open question on `gdtoolkit` before reaching for one.

## The file sets

`ts/project` distinguishes four file sets and calls picking the wrong one a real defect. The same
distinction applies, with a different boundary in the middle:

- **`projectFiles()`** — everything under the root.
- **`sourceFiles()`** — what analysis reports in. The exclusion that matters here is `addons/`.
  Third-party plugin code is vendored into the project tree and is not the author's to fix; on the
  corpus measured in the roadmap it is 151 of 203 `.gd` files and the source of every false positive
  a dead-script analysis produced. `.godot/` is the engine's import cache and is never source.
- **`analysisFiles()`** — deliberately *not* narrowed, for the same reason `compilationFiles()` is
  not: a reference from an addon into project code is still a reference, and a dead-script analysis
  that cannot see `addons/` will call a script dead that a plugin loads.
- **`targetFiles()`** — `sourceFiles()` narrowed by the caller's `files` scope.

The reporting-scope rule from `core/files` is unchanged and is the reason the split is worth keeping:
narrowing what is *reported* must never narrow what is *analyzed*.

## Path resolution

Three schemes address the same file, and a graph that resolves only the first is wrong:

- **`res://path/to/file.gd`** — project-root-relative. The common form, in `preload`, `load`, scene
  `ext_resource`, and `project.godot`.
- **`uid://` + `.gd.uid`** — a stable identity independent of location, introduced so moving a file
  does not break references to it. Each `.gd` has a sibling `.gd.uid` holding one line
  (`uid://cr2c2xs0amisn`), and scenes may reference either form. Resolution is the reverse index over
  those files.
- **Bare relative paths** — `plugin.cfg` names its entry point as `script="plugin.gd"`, relative to
  the addon directory and with no scheme at all. This is not an edge case: it is how every editor
  plugin in a project is entered, and a resolver that only understands `res://` reports all of them
  dead.

## `project.godot` is part of the graph

It is an INI file, and the `[autoload]` section names scripts that nothing else references:

```ini
[autoload]
GameState="*res://scripts/game_state.gd"
```

The leading `*` marks the node as enabled and is not part of the path. An autoload is also a global
identifier — `GameState` is in scope in every script in the project without an import — so the same
section is what makes otherwise-undeclared identifiers legal.
