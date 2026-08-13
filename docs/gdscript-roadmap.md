# GDScript roadmap

What a second language pack costs, what Godot actually gives us to build it on, and what to build
first. Everything below was measured against **Godot 4.7.1.stable** on macOS during the investigation
that produced [`gd/`](../gd/README.md); nothing here is inferred from documentation.

The prompt for this was a forum thread saying the language server needs the editor. That is true and
it is not the obstacle it sounds like — but the obstacle that *is* real turned out to be somewhere
else entirely, and it took a wrong measurement to find it.

---

## 1. The connection exists

```sh
godot --headless --editor --lsp-port 6011 --path <project>
```

listens on TCP 6011 and speaks LSP. `--headless` alone does not — the server is part of the editor —
but `--headless` and `--editor` compose, which is what the forum thread missed. `--lsp-port` exists
because of [godotengine/godot#81844](https://github.com/godotengine/godot/pull/81844), added so
editors could run a private instance per workspace instead of fighting over 6005.

Two properties of that connection shape everything else, and both are better than expected:

**It indexes the whole project itself.** `textDocument/references` on `take_damage` returned a call
site in `spawner.gd`, a file the client had never sent `didOpen` for. tsserver would have needed the
file opened. This removes the "open 203 files to ask one question" problem before it exists.

**Its `WorkspaceEdit` is already the right shape.** `textDocument/rename` returns `changes` keyed by
file URI, which is `core`'s `WorkspaceEdit` with no translation, exactly as the LSP-shaped core
contracts were designed for.

### The trap, which cost a full round of conclusions

A Godot editor was already running on this machine, holding the default port 6005. A second instance
launched with `--lsp-port 6005` **did not error, did not exit, and did not listen.** It ran happily.
Every request went to the other editor, serving an unrelated project, and came back fluent and wrong:
`textDocument/references` returned `[]`, `textDocument/rename` returned `{"changes": {}}`, and a hover
described a method from a codebase that was not under test.

The first draft of this document concluded from that evidence that GDScript's language server
advertises references and rename and implements neither. That conclusion was wrong, and it was wrong
in the most dangerous available way — a plausible negative result, consistent across four probes,
that would have cancelled the entire mutating half of the pack.

What caught it was `lsof` on the port, not anything in the protocol. What *should* catch it in code:
the server sends `gdscript_client/changeWorkspace` naming the project it is really serving, and a
`window/showMessage` reading *"The GDScript Language Server might not work correctly with other
projects than the one opened in Godot."* A session that does not check the first against the root it
asked for is not a session, and `rootUri` is advisory — `--path` is what selects the project.

This is the same lesson as
[verify against the compiler, don't reason about it](../CLAUDE.md#verify-against-the-compiler-dont-reason-about-it),
one level down: verify you are talking to the compiler you think you are.

### Capabilities, measured

Working: `references`, `rename` (+`prepareRename`), `definition`, `declaration`, `documentSymbol`,
`documentHighlight`, `hover`, `completion`, `documentLink`.
Absent — *Method not found* when called regardless of what the handshake says: `workspace/symbol`,
`textDocument/codeAction`, `textDocument/formatting`. `textDocumentSync.change` is `1` (Full), so
`didChange` sends whole documents.

`--check-only --script <file>` runs without the editor and reports parse errors only, one file per
process — and **exits 0 whether the file parses or not**, measured both ways. Anything built on it
would have to parse stderr. It is not a shortcut to a gate.

---

## 2. The obstacle that is real: the guard has no cross-file analogue

`ts/` can ship 30 refactorings because `diagnosticsIntroducedBy` makes them safe: overlay the edit,
typecheck, diff, refuse on any new diagnostic. Whether that ports is the question that decides the
shape of this pack, so it was measured directly.

**The mechanism ports.** `didChange` with modified text re-diagnoses that buffer and leaves disk
untouched — an injected undefined identifier produced
`Identifier "no_such_variable" not declared in the current scope.`, reverting the buffer cleared it,
and the file on disk was byte-identical throughout.

**The reach does not.** Renaming a declaration in `player.gd`'s buffer while `main.gd` still called the
old name produced no diagnostic for `main.gd` — not automatically, and not after explicitly poking
`main.gd` with a `didChange` to force re-analysis. Cross-file resolution runs against the server's own
workspace index, not the client's buffers.

Every refactoring worth writing is cross-file. So the guard the rule in CLAUDE.md demands is not
available over the LSP, and the honest options are in
[`gd/refactors/README.md`](../gd/refactors/README.md) — ship nothing, ship rename with a weaker guard
and loud `warnings`, or build the guard out of process against a project copy at 12–40s per
verification. **Prototype the third before arguing about the second.**

---

## 3. Where the value actually is

Not in the diagnostics. Measured over a 203-file, 49,783-line Godot project: **23 diagnostics, all
warnings, in 8 of 203 files** — 21 `STATIC_CALLED_ON_INSTANCE`, 1 `SHADOWED_VARIABLE`, 1
`UNUSED_PARAMETER`, zero errors. That is what the editor already underlines, and a healthy project has
almost none of it.

The value is in scenes, because nothing looks at them. `.tscn` and `.tres` hold script attachments,
signal connections, exported property values and resource paths — all of it referencing GDScript by
string, none of it visible to the language server or the engine's diagnostics.

The load-bearing measurement, reproducible in `fixtures/basic-gd`: renaming the signal `died` through
the language server rewrites the declaration and the `emit`, reports success, and leaves
`[connection signal="died" from="Player" to="." method="_on_player_died"]` in `main.tscn` pointing at a
signal that no longer exists. Nothing reports it. The handler silently stops firing at runtime.

**A tool that can see both halves is the entire argument for this pack**, and it is a stronger argument
than the TypeScript pack ever had, because there `tsc` was already covering most of the ground.

### The reference forms nothing static can see

Counted over the same 203-file corpus, as a population estimate for
[`gd/scene`](../gd/scene/README.md):

| Form | Count | Notes |
| --- | ---: | --- |
| `preload`/`load("res://…")` | 196 | resolvable; `documentLink` does it for free |
| `.connect(` | 116 | signal wiring, some by string name |
| `$NodePath` | 60 | resolvable only against the scene the script is attached to |
| `has_method` / `has_signal` | 59 | deliberate duck-typing, not defects |
| `call` / `callv` / `call_deferred` | 52 | method by string |
| `class_name` declarations | 71 | referenced by name, never by path |
| autoloads | 9 | global identifiers declared in `project.godot` |

These are **syntactic candidates, not motivated targets**, and the distinction is the accounting
convention [docs/next-roadmap.md](next-roadmap.md) insists on. One number was dropped from this table
for failing it: `.get("` / `.set("` appears 1,353 times and is overwhelmingly `Dictionary.get`, which
is ordinary correct code and not string-keyed property access at all. Quoting it as a defect
population would have inflated the case for this pack by an order of magnitude.

---

## 4. What to build, in order

Each step is independently useful and ends in a measurement that can cancel the next one.

**1 — `gd/server` + `gd/project` + `gd/ferry`.** No tools, just a session that binds, verifies via
`gdscript_client/changeWorkspace` that it reached the right project, caches per root, and serializes.
Requires one change in `core`: `LspClient` takes a `ChildProcess` and reads its stdio, so it needs a
`{reader, writer}` seam to accept a TCP socket. That change is small and benefits any future pack.

**2 — `gd/diagnostics`.** The whole tool is "collect `publishDiagnostics`, map to `Finding`". Two
things it must get right, both measured: the machine-readable code lives in the `(UPPER_SNAKE)` prefix
of the message because the `code` field is always `0`; and a parse error suppresses the entire warning
pass for that file, so a baseline taken over broken code records absences that a later fix turns into
apparent regressions. Say that in the tool's output, not only in its README.

**3 — `gd/graph`.** The resource graph over all six edge kinds in
[`gd/graph/README.md`](../gd/graph/README.md). Not a shippable tool by itself; everything after this
needs it.

**4 — `gd/scene/broken-refs`.** The flagship. Signal connections naming a signal or handler that does
not exist, `ext_resource` paths resolving to nothing, `@export` values for properties the script no
longer declares. **Measure precision by hand on two corpora before writing it**, against the bar in
[docs/next-roadmap.md](next-roadmap.md): a `warning` must be right more often than it is wrong.

**5 — reconsider refactorings**, with §2's prototype in hand and not before.

### Cancelled before starting

**`gd/graph/dead-scripts`** was going to be step 4, as the direct analogue of
`ts/graph/dead-exports`. It was measured first, and it reported **34 unreferenced scripts of which 34
were false**: 6 `addons/*/plugin.gd` entered from `plugin.cfg`'s `script=` key, and 28
`addons/godot_ai/handlers/*.gd` loaded from a directory constant scanned at runtime, which no static
resolution can reach. In the project's own 52 first-party files the count was **zero** — so after
excluding `addons/` from the reporting scope the tool reports nothing, correctly, and has demonstrated
no population at all. It goes back in the queue behind a second corpus, and it does not ship on one.

---

## 5. Open questions

**Is there a second parser, and should there be?** The engine's compiler has no library form, so
anything needing a real AST — the `comments/`, `dupes/`, and `types/` families all do — needs either
`gdtoolkit` (Python: `gdparse`, `gdlint`, `gdformat`, Lark-based) or a hand-written parser. Both
disagree with the engine somewhere, and the engine is the only opinion that predicts what the game
does. `gdtoolkit` also adds a Python runtime to a Node project. Not needed for steps 1–4; decide when
something actually requires it.

**Does the pack pay for the editor's startup?** 12s for a 7-file fixture, 40s for 203 files, scaling
with project size. The ferry cache makes that once-per-conversation, which is fine for MCP and for an
explicit CLI run. Whether it is tolerable in a pre-commit hook is unmeasured, and it decides whether
GDScript check suites are a real feature or a nominal one. Measure before designing suites.

**What is the block/warn split?** The TypeScript split is measured against this repository. There is no
equivalent home project for GDScript, and `debug/gdscript/warnings/*` in `project.godot` means two
Godot projects can disagree about what is even a warning. The split may have to be per-project rather
than a shipped default — which would be a genuine difference from `ts/checks.ts`, not an oversight.

**Does `novelty` port?** `changed-lines` suits anything anchored on the offending code, which
`diagnostics` is. It is wrong for scene checks in the same way it is wrong for `graph/cycles`: a
broken connection is reported in the `.tscn`, while the commit that broke it edited the `.gd`. Those
need `baseline`, and the degradation rule — a policy the event cannot supply inputs for falls back to
the next broader one **and says so** — matters more here, not less.

---

## 6. What this does not cover

**One corpus, one project, one author.** Every count in §3 and the dead-script result in §4 come from
a single 203-file game, 151 files of which are vendored addons, with only 7 scenes — unusually
code-driven for a Godot project. A scene-heavy project would move the scene numbers, which are the
ones the pack's whole case rests on. **Nothing in §4 step 4 should be built on this corpus alone.**

**One engine version, one platform.** 4.7.1 on macOS. The capability list is worth re-measuring per
version: `--lsp-port` is recent, headless LSP is actively being worked on, and a proposal exists for a
dedicated `--gdscript-lsp` flag that would remove `--editor` from the launch line entirely.

**No precision measurement exists yet for anything in `gd/scene`.** §3 argues the value is there and
§4 makes measuring it step 4's first task. Those are not the same thing, and the ten candidates in
[next-roadmap.md](next-roadmap.md) — median precision 0.068, all ten nominated by confident intuition
— are the reason to keep them apart.
