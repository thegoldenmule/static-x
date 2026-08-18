# daemon

Keeps a Swift session warm between CLI runs. A background process holding one
`core/ferry` and its sessions, reached over a unix socket keyed by version and project root.

## What it is *not* for

It is not for amortizing startup. That was the assumption when this pack was scoped, and it is
measured false: `initialize` against a 204-file SwiftPM project takes **530ms cold and 270ms warm**,
and a `commit`-suite run over ten changed files costs **380ms end to end**. That is comparable to
tsserver, which `ts/` pays per invocation with no daemon at all. `gd/`'s 12–40s editor startup, which
made its ferry cache "not an optimisation", has no analogue here.

Stating that plainly matters, because a README claiming a benefit the numbers do not show is how the
next person justifies keeping something that should have been deleted.

## What it *is* for

- **The `(path, mtime, size)` memo.** Comment ranges are cached across runs, so a second run over an
  unchanged file costs nothing. Within a run the ferry already caches the session; only a process
  that outlives the run can cache the work.
- **Xcode projects.** Per-file latency without a `buildServer.json` is 35–70× SwiftPM's — 71ms median
  and a 4.7s p95 on `drum/ios`. The memo is worth much more there than on SwiftPM, and it is the
  strongest argument this directory has.

## Properties, each with a test

- **A daemon failure is never a tool failure.** Any error — spawn, connect, protocol, timeout — falls
  back to an in-process session. A latency optimisation must never become a new way for the tool to
  break.
- **The version is in the socket name.** An upgraded `static-x` never talks to a stale daemon; it
  spawns its own and the old one idles out. No negotiation, no migration.
- **Spawn races resolve by bind.** Two concurrent invocations both try to listen; `EADDRINUSE` names
  the loser, which connects to the winner. A stale socket after a crash fails `ECONNREFUSED`, is
  unlinked, and is respawned.
- **The scope early exit stays client-side.** A commit naming no `.swift` file is answered before the
  client contacts — let alone spawns — the daemon.
- **It idles out.** A developer who runs one command should not be left holding a process.

## Why here and not in `core/`

Because it has one implementation, and a seam with one implementation is a guess. tsserver has the
same shape of problem and would want the same solution, and when it does, this moves. Putting it in
`core/` now would mean designing for a caller that does not exist while risking the path that does.
