# ferry

Dispatch from an adapter to a tool: one cached session per resolved project root, calls serialized
against it, project config applied, `files` scope honoured. The counterpart of
[`ts/ferry`](../../ts/ferry/ferry.ts), and the same four jobs for the same reasons.

Two of them get sharper here.

**Caching is not an optimisation.** `TsFerry` caches a session so a conversation pays language-server
startup once, and typescript-language-server starts in well under a second. A Godot editor takes
12–40s to reach the point where it answers correctly — measured, and scaling with project size rather
than being a fixed cost. A ferry that dropped its session between calls would make a check suite
unusable, and would make a hook unusable outright.

**Serializing is not optional.** The TypeScript reason — one session owns a mutable program and an
LSP connection — applies, and a stronger one is added: the session owns a *subprocess holding a TCP
port*, and the engine's own warning is that a language server serves one project. Two concurrent
runs against different roots need two editors on two ports, which is exactly what the
[server](../server/README.md) layer's bind-first port selection is for.

The `files` reserved key behaves as it does in `ts/ferry`, and the early exit it enables is worth more
here, not less: a scope naming no `.gd` file should be answered before an editor is launched, because
the launch is the expensive part. A docs-only commit must not start Godot.

One thing the TypeScript ferry does not have to do: **confirm the session is bound to the project it
was asked for**. See the server README — a port collision produces a working connection to the wrong
project, and the ferry's cache key is a project root, so a mis-bound session would be cached under a
root it does not serve and every later call would inherit the error.
