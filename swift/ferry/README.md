# ferry

Dispatch from an adapter to a tool: one cached session per resolved project root, calls serialized
against it, project config applied, `files` scope honoured.

Unlike [`ts/ferry`](../../ts/ferry/ferry.ts) and unlike `gd/`'s plan, there is almost nothing here.
The four jobs live in [`core/ferry`](../../core/ferry/ferry.ts), generic over the session type, so
this pack supplies a session factory and an extension set and inherits the rest. That is the whole
point of having moved it: two implementations of call serialization would be two things to keep in
step.

What this pack adds is the [daemon](../daemon/README.md) in front of it. The ferry the daemon hosts
is the same `core/ferry`, so config application, `files` scoping and per-root serialization behave
identically whether a call went through the daemon or fell back in-process.

One property worth keeping in view: the `files` early exit happens **before** the daemon is
contacted, let alone spawned. `FileScope.selectsNothing()` is per-pack, so a commit touching only
`.ts` files answers `[]` here without ever starting sourcekit-lsp.
