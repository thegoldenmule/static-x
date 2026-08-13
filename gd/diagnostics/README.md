# diagnostics

The engine's own errors and warnings, surfaced as `Finding[]`. The cheapest tool in the pack and the
first one to build — it needs the session and nothing else.

## How they arrive

Not as a request. The server pushes `textDocument/publishDiagnostics` after a `didOpen` or a
`didChange`, per file, and a tool collects them rather than asking for them. Since the server already
indexes the whole project, a project-wide run still has to `didOpen` each file to *get* diagnostics
for it — indexing and diagnostics are not the same thing, and only the second is push-based.

## The shape, and the two things wrong with it

```json
{
  "code": 0,
  "message": "(UNUSED_PARAMETER): The parameter \"thing\" is never used in the function \"unused_param()\". If this is intended, prefix it with an underscore: \"_thing\".",
  "range": { "start": { "line": 14, "character": 1 }, "end": { "line": 14, "character": 29 } },
  "severity": 2,
  "source": "gdscript"
}
```

**`code` is always 0.** It is not a code; it is a placeholder. The machine-readable identity of a
warning is the `(UPPER_SNAKE)` prefix on the message text, and a tool that wants a stable `Finding.code`
has to parse it out of the prose. Errors have no prefix at all — `Function "undefined_function()" not
found in base self.` — so `severity` is what separates the two families, not the presence of a code.

**Severity is engine policy, not a fixed map.** `severity: 1` is an error and `2` a warning, but which
checks produce which is configurable per project under `debug/gdscript/warnings/*` in
`project.godot`, including promoting warnings to errors. Findings inherit that, which is correct — the
project's own settings should decide — and it means the block/warn split for this tool cannot be
copied from one project to another.

## A parse error suppresses the warning pass

Measured, and the reason `fixtures/basic-gd` has both `warnings.gd` and `parse_error.gd`:

- `warnings.gd` — no errors — reports 5 warnings: `UNUSED_SIGNAL`,
  `UNUSED_PRIVATE_CLASS_VARIABLE`, `UNREACHABLE_CODE`, `UNUSED_PARAMETER`, `INTEGER_DIVISION`.
- `parse_error.gd` — one parse error — reports that error and **zero** warnings, though it contains an
  unused signal and a shadowed parameter that `warnings.gd` would have reported.

So warning counts are only comparable across files that parse. A baseline taken while a file is broken
records the absence of warnings that will appear the moment it is fixed, and a ratchet reading that
baseline would see the fix as a regression. This has to be stated in the tool's own output, not just
here.

## What it is worth, measured

Against a 203-file, 49,783-line project: **23 diagnostics, all warnings, in 8 files** — 21
`STATIC_CALLED_ON_INSTANCE`, 1 `SHADOWED_VARIABLE`, 1 `UNUSED_PARAMETER`. Zero errors.

That is close to silent on a healthy project, which by [the rule in CLAUDE.md](../../CLAUDE.md) is the
argument for a tool blocking rather than warning. It is also the argument for not overestimating this
tool: it reports what the editor already underlines. Its value is that it reports it to a hook and to
an agent with no editor open, and that a commit cannot introduce a parse error unnoticed.

## Not a linter

`gdlint` exists and is not this. The engine's diagnostics are the engine's own semantic analysis, and
they are the only opinion that is guaranteed to match what the game will actually do.
