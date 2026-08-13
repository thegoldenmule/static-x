# scene

What only a `.tscn` / `.tres` reader can check. This directory has no counterpart in `ts/`, and it is
where the pack earns its keep.

## Why it exists

The language server does not read scenes. The engine's diagnostics do not cover them. A scene is a
text file full of references into GDScript — a script attached to a node, a signal wired to a method,
a resource loaded by path — and every one of those is a string that no analysis in the pack's other
directories can see.

The demonstration is in `fixtures/basic-gd`, and it was measured rather than argued. Rename the signal
`died` through the language server and it reports success, rewriting the declaration and the `emit`.
It does not touch:

```
[connection signal="died" from="Player" to="." method="_on_player_died"]
```

The scene now connects a signal that does not exist. Nothing warns. The failure is at runtime, in a
callback that silently never fires — which is the worst shape a defect can have, because there is no
crash to trace back.

## The checks this makes possible

Ranked by how much of the above they recover, none built, none yet measured for prevalence — that
measurement is the roadmap's first job for this directory:

- **Signal connections naming a signal that does not exist** on the attached script, or a handler
  method that does not exist on the target. Both halves of a `[connection]` line are checkable against
  what the language server already knows about the two scripts involved.
- **`ext_resource` paths that resolve to nothing** — a script or resource moved or deleted without the
  scene being updated.
- **`$NodePath` and `get_node("…")` addressing a node the scene does not contain.** Checkable only for
  the scene a script is actually attached to, which the graph knows and the script does not.
- **`@export` properties set in a scene that the script no longer declares.** The scene keeps the
  value; the script has no field for it; the value is silently dropped on load.

## The thing to be careful about

A scene is data, and data is allowed to be dynamic. Nodes are added at runtime, scripts are swapped
with `set_script`, signals are connected in `_ready` and disconnected later, and a `$NodePath` may
address a node that only exists after another scene is instanced into place. Every check above has a
false-positive family, and the roadmap's bar — a `warning` must be right more often than it is wrong,
measured by hand on real code, before the tool exists — applies here without discount.

The reason to think the numbers will land better than the ten candidates in
[docs/next-roadmap.md](../../docs/next-roadmap.md) is that this class has no competition: `tsc` had
already caught most of what those candidates proposed, and here there is nothing else looking at all.
That is a reason to measure, not a reason to skip measuring.
