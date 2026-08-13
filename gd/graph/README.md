# graph

The resource graph: which file references which, across every scheme Godot uses to say so. The
counterpart of [`ts/graph`](../../ts/graph/), and the layer most of the pack's analysis sits on.

TypeScript has one edge kind — a resolved module specifier — and `ts.Program` resolves it. GDScript
has five, and nothing resolves them for you:

| Edge | Where it is written | Resolution |
| --- | --- | --- |
| `preload("res://…")` / `load("res://…")` | `.gd` | root-relative path |
| `[ext_resource path="res://…"]` | `.tscn`, `.tres` | root-relative path |
| `uid://…` | `.tscn`, `.tres` | reverse index over sibling `.gd.uid` files |
| `[autoload] Name="*res://…"` | `project.godot` | root-relative path, `*` stripped |
| `script="plugin.gd"` | `addons/*/plugin.cfg` | relative to the addon directory, no scheme |
| `class_name` reference | `.gd` | global class registry, not a path at all |

The last row is the one with no path in it. A script declaring `class_name Player` is referenced by
any file that writes `Player`, with nothing naming the file — so a file-level graph built from paths
alone misses it entirely. The language server's `textDocument/references` resolves it, which is the
one part of this graph that does not need building.

`documentLink` also resolves `preload("res://…")` to a file URI for free, and is worth using in
preference to re-implementing path resolution for that edge — measured working on
`fixtures/basic-gd/spawner.gd`.

## Why this is not grep

Every one of those edges is greppable and none of them is *resolvable* by grep. The question a tool
answers is not "does this string appear" but "after resolving `uid://cr2c2xs0amisn` through
`player.gd.uid`, and `script="plugin.gd"` through the directory it sits in, and `Player` through the
global class registry, does anything reach this file". That is the same distinction
`ts/graph/dead-exports` draws when it resolves tsconfig path aliases.

## The one measured result so far

A dead-script analysis over a 203-file project reported **34 unreferenced scripts, all 34 of them
false**, and both causes are structural rather than bad luck:

- **`addons/*/plugin.gd` × 6** — entered from `plugin.cfg`'s `script=` key, which the analysis did not
  read. Fixed by resolving `plugin.cfg`.
- **`addons/godot_ai/handlers/*.gd` × 28** — loaded from a directory constant,
  `const HANDLERS_DIR := "res://addons/godot_ai/handlers/"`, scanned at runtime. **Not fixable.** No
  static resolution reaches these, and this is precisely the case CLAUDE.md requires a tool to name in
  `warnings` rather than pretend it handled.

In the project's own 52 first-party files the count was **zero**. Which is the finding: the tool as
specified would have produced 34 findings and 0 defects, and excluding `addons/` from the reporting
scope — while keeping it in the analysis scope, per [project](../project/README.md) — takes it to 0
and 0. Whether a population exists at all is the open question the roadmap records, and it must be
answered on a second corpus before this ships.
