# refactors

Deferred, and this README is the reason rather than a placeholder.

## The rule that blocks it

> Every mutating tool runs `diagnosticsIntroducedBy` before writing. Non-empty `newDiagnostics` blocks
> the apply, always. — [CLAUDE.md](../../CLAUDE.md)

That guard works by overlaying the proposed edit onto a language service, typechecking, and diffing
against the pre-edit diagnostics. Half of it ports cleanly and half of it does not, and both halves
were measured against Godot 4.7.1.

**What works.** Send `didChange` with modified text and the server re-diagnoses that buffer without
touching disk. Introducing an undefined identifier produced
`Identifier "no_such_variable" not declared in the current scope.`; reverting the buffer cleared it;
the file on disk was byte-identical throughout. That is the guard's mechanism, available and cheap.

**What does not.** It sees one file. Renaming a declaration in `player.gd`'s buffer while `main.gd`
still calls the old name produced **no diagnostic for `main.gd`** — not automatically, and not after
explicitly poking `main.gd` with a `didChange` to force re-analysis. Cross-file symbol resolution
happens against the server's own workspace index, not against the client's buffers, so the caller is
still resolved against the file as it exists on disk.

A guard that cannot see the blast radius is not the guard the rule describes. Every interesting
refactoring is cross-file — that is what makes it worth a tool instead of an editor macro — so this is
not a limitation at the margin. It is the centre.

## What is nevertheless available

`textDocument/rename` works, and works cross-file: renaming `take_damage` returned a `WorkspaceEdit`
covering the declaration in `player.gd`, the call in `main.gd`, and the call in `spawner.gd` — the
last in a file the client had never opened. It returns `changes` rather than `documentChanges`, which
maps onto `core`'s `WorkspaceEdit` with no translation.

So the engine will happily perform a rename it cannot verify, and will silently miss every scene
reference while doing it. `ts/refactors/rename` is dry-run by default and refuses renames that would
introduce compile errors; a GDScript rename can offer the first and cannot honestly offer the second.

## The three ways forward, and what each costs

1. **Ship nothing here.** The pack is analysis-only. Costs the whole category; costs nothing false.
2. **Ship rename with the guard it can actually have** — single-file diagnostics, plus a scene-reference
   check from [`scene/`](../scene/README.md) that finds what the rename is about to break, plus
   `warnings` naming every reference form neither can see (`call("method_name")`, `connect` by string,
   `has_method`, `get`/`set` by property name). This is the honest version, and CLAUDE.md's rule about
   saying so in `warnings` is written for exactly this situation. It is still weaker than every
   mutating tool in `ts/`, and the README would have to say so plainly.
3. **Build the guard properly, out of process.** Copy the project, apply the edit to the copy, run a
   fresh headless editor against it, diagnose every file, and diff against the same census taken
   before. Sound, and the only option that actually satisfies the rule. It costs a project copy and a
   12–40s editor start per verification — plausible for an explicit refactoring invocation, not for
   anything on a hook. Hardlinking the asset tree makes the copy cheap; the editor start is
   irreducible.

Option 2 is the one to argue about. Option 3 is worth prototyping before that argument, because if it
is affordable the argument does not need to happen.

## Which refactorings would even be worth it

Not the `ts/` catalogue. Most of it is about type structure — extract interface, widen type, enum to
const object — and GDScript has none of the constructs. What a Godot project actually accumulates is
scene-shaped: a node moved to a different parent, a script split off an autoload, a signal renamed, a
scene extracted from another scene. Those all involve the `.tscn` half, which the language server does
not touch, so they would be this pack's own work rather than a wrapper over the engine's.

That is a separate roadmap and should not be written until `scene/` has measured numbers behind it.
