# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

There is no build step — `tsx` runs the TypeScript sources directly, so the CLI and the MCP server
start from the working tree.

```sh
npm run typecheck                  # tsc, noEmit
npm run lint                       # eslint, type-checked rules
npx vitest run                     # 838 tests, ~45s wall (parallel; ~9 min of real compilation)
npx vitest run ts/refactors/rename # one file, or any path substring
npx vitest run -t 'repoints every importer'   # one test by name
npm run test:watch

npm run sx -- ts/graph/cycles --project fixtures/graph-ts --format text   # note the `--`
npm run sx -- check --list --project .          # the gates this project defines
npm run sx -- check commit --project .          # what a pre-commit hook runs
npm run sx -- ratchet --project .               # what could be tightened (dry run)
npm run mcp                        # the MCP server on stdio
```

All three checks pass before a commit. Fixtures are excluded from both tsconfig and eslint, so they
may hold deliberate problems — that is what they are for.

Exercise a tool against a fixture rather than against this repo: `--project fixtures/<name>-ts`.
Exit codes are `0` clean, `1` findings reported, `2` usage or execution error.

## Architecture

Four layers, and the boundaries between them are the point.

**`core/`** holds contracts no language knows about: `Finding`, `WorkspaceEdit`, `Tool`,
`ProjectSession`. Positions and edits are LSP-shaped so output can flow to and from language servers
without translation. Also here: `static-x.json` loading and finding filters (`core/config`), the
reporting-scope set (`core/files`), edit application (`core/edits`), and check suites
(`core/checks`).

**`ts/`** is the TypeScript language pack — the tools plus the machinery to bind to a project. Other
languages would sit beside it.

**`cli/` and `mcp/`** are delivery adapters. They parse argv or MCP arguments and print; they hold no
analysis. A tool is `run(session, input)` and never learns which one called it.

**`hooks/`** is what `static-x install` writes, kept in the tree as reference. `hooks.test.ts`
asserts the two are byte-identical, so neither can drift.

### Gates: what a hook runs

A hook runs `static-x check <suite>`, never a loop over the CLI: `core/checks` runs every tool in the
suite through one dispatcher, so the suite pays project load once — 5.9s of five processes against
0.93s of one, measured here.

A suite lives in `static-x.json` under `checks`, beside the tuning the same tools already read. Each
tool is `block`, `warn`, or `off`, with optional per-gate tuning layered over the project's own. The
TypeScript defaults are `ts/checks.ts`, and their block/warn split is measured, not chosen: only
`async/floating-promises` and `graph/cycles` report nothing against this repository, so only those
two block. A gate that blocks on taste gets `--no-verify`'d, and is then worth nothing on the day it
catches a dropped promise.

`baseline` and `ratchet` divide along one line: baseline **accepts** whatever it finds, which is what
lets a gate go on a codebase that never had one; ratchet **only tightens**, and refuses the whole run
while anything has regressed. Keep that split — a ratchet that quietly banked a regression would be
worse than not having one. It is deliberately not a hook and not a CI step.

`novelty` is the part that makes a gate installable, and the part to think hardest about when adding
a tool to one. Unfiltered, the commit suite finds something in 79 of this repository's 141 source
files — a hook reporting all of that rejects most commits over code its author never wrote.
`changed-lines` intersects findings with the diff's hunks and suits any tool that anchors on the
offending code. It is wrong for `graph/cycles` (anchored on one file of the SCC) and
`graph/dead-exports` (reported in the *declaring* file, not the one whose last import you deleted) —
those need `baseline`. A policy the event cannot supply inputs for degrades to the next broader one
and **says so**: silence there looks exactly like a gate that found something real.

### The path a call takes

`TsFerry` (`ts/ferry/ferry.ts`) is the only route from an adapter to a tool, and it does four things
no tool should repeat. It caches one `TsProjectSession` per resolved project root, so a conversation
pays language-server startup once. It **serializes** calls against the same root — one session owns a
mutable program, an LSP connection, and a reporting scope, none of which survive two calls
interleaving. It applies the project's `static-x.json`: config `input` under explicit input, then
ignore/severity/confidence filters on `Finding[]` output. And it owns the reserved `files` key, which
is dispatch-level rather than per-tool because every analysis tool accepts it.

`files` narrows what is **reported**, never what is **analyzed**. Symbol indexes, import graphs, and
duplicate groups still span the project — that is what keeps the answers true, since a comment names
symbols declared elsewhere and a cycle you just created runs through files you didn't touch. A scoped
run says exactly what a full run says about those files. A scope naming no source file is answered
before a session is opened, so a docs-only commit costs nothing.

### Three views of one project

`TsProjectSession` (`ts/project/session.ts`) owns them, each created lazily:

- **the LSP client** (`typescript-language-server`) for what the protocol already does well — rename,
  references, definitions. `openDocument` waits for published diagnostics, because tsserver answers
  before its project finishes loading and pre-load answers are wrong.
- **`ts.LanguageService`** (`ts/project/service.ts`) for everything a bare `ts.Program` cannot do: it
  indexes no references and offers no transformations, so `findReferences`, `getApplicableRefactors`,
  `getEditsForRefactor`, `getEditsForFileRename`, and the code fixes are only reachable here.
- **`ts.Program` + `TypeChecker`**, served by that same service, for ASTs and symbol tables.

The service host reads through an **overlay**, which is what makes the guard below possible.

Its file-set methods are not interchangeable, and picking the wrong one is a real defect:
`projectFiles()` is everything under the root; `sourceFiles()` drops hidden directories (generated
framework output like `.next/types`) and is what analysis reports in; `compilationFiles()` is
deliberately *not* narrowed to the root, because an edit's blast radius is the program rather than
the directory; `targetFiles()` is `sourceFiles()` narrowed by the caller's scope, and is what a tool
iterates to produce findings.

### The guard under every mutating tool

`diagnosticsIntroducedBy` (`ts/refactors/guard.ts`) overlays the proposed edit onto the language
service, typechecks, and diffs against the pre-edit diagnostics — by code and message only, since
positions legitimately shift. Files the edit creates enter the program and files it deletes leave it,
or the guard would report clean on code it never compiled. Non-empty `newDiagnostics` blocks the
apply, always.

After a real apply: `applyWorkspaceEdit`, then `session.invalidate(written)` so both views re-read
from disk, then close the touched LSP documents.

### Shared refactoring machinery

`ts/refactors/` holds what the individual refactorings share — read these before writing a new one.
`refactor-action.ts` is the safe wrapper around TypeScript's own engine (it throws rather than
refusing; an action can be listed and still be unavailable) and infers the project's indentation,
quote style, and module-specifier ending so generated code doesn't announce itself. Alongside it:
`references.ts` (classifying reads vs. writes), `selection.ts` (addressing a range by the code it
contains), `imports.ts`, `signatures.ts`, `substitution.ts`, `text-changes.ts` (TS edits →
`WorkspaceEdit`), and `output.ts` (the `RefactorOutput` envelope). `testing.ts` gives apply-mode
tests a disposable copy of a fixture and dry-run tests a `preview()` of what an edit would produce.

`ts/ast/` holds the cross-tool AST helpers: `targets.ts` resolves the `symbol`/`file`/`line`/
`character` addressing every symbol-addressed refactor accepts, so one convention and one good
ambiguity error serve all of them.

## Commit incrementally

Commit as you go, not once at the end. Each logical step — a piece of shared machinery, a tool, a
fixture, a doc rewrite — is its own commit, made when that step is done and verified rather than
held back until everything is finished. A branch of small commits is reviewable and bisectable; one
large commit at the end is neither, and it loses the record of what was tried.

This does not need asking about each time. Land work in commits by default.

- **Commit to `main`.** Don't create a branch, and don't ask whether to — `main` is the working line
  here.
- Conventional Commits, enforced by commitlint: `type(scope): subject`, subject ≤ 72 chars, body
  wrapped at 100.
- Say *why* in the body, not what the diff already shows — a defect's mechanism, a measurement that
  settled a decision, an option rejected and the reason.
- Typecheck, lint and tests pass before each commit, so every commit on `main` is a working one.

## Verify against the compiler, don't reason about it

Every claim about what TypeScript's language service does is checkable in a few minutes with a
scratch project and `npx tsx`, and a surprising number of reasonable-sounding beliefs about it are
wrong. Several defects in this repo's history came from assuming an API behaved sensibly:
`getEditsForRefactor` throws rather than refusing; a caret offset passed to the move refactoring
moves every statement in the file; `ReferenceEntry.isWriteAccess` is true for a destructuring read.

Probe first, then write the code, then encode what you measured as a test. `node_modules/typescript/lib/typescript.js`
is readable and is the authority when probes disagree.

## Tool conventions

Read `ts/refactors/rename/` and `ts/graph/dead-exports/` before adding a tool; they are the
reference implementations for the mutating and analysis shapes.

- Tools are data-in, data-out, named path-like and lowercase (`ts/refactors/move-symbol`), and
  registered in `ts/registry.ts`. Each ships a `README.md`, an integration test, and its own
  `fixtures/<name>-ts/` project.
- Analysis tools return `Finding[]`; refactorings return the `RefactorOutput` envelope, are dry-run
  by default, and write only with `apply: true`.
- Every mutating tool runs `diagnosticsIntroducedBy` before writing. Non-empty `newDiagnostics`
  blocks the apply, always.
- Where the typecheck structurally cannot see a failure — a reference through a string key, a path
  in `package.json`, a guarantee the language erases — say so in `warnings`. A green compile is not
  proof of safety, and a tool that implies otherwise is worse than no tool.
- Semantic, not lexical: if grep could do it, it does not belong here.
- A new analysis tool decides whether it belongs in a default suite (`ts/checks.ts`) by running
  against this repository first. It blocks only if it reports nothing here or close to it; anything
  else goes in at `warn`, if at all. Record the count in the commit — that number is the argument.
- A new tool is listed in `ts/README.md`'s table too; `ROADMAP.md` (refactorings) and
  `docs/next-roadmap.md` (analysis) record what has been considered and what was cut, with the
  reason — check them before proposing work.

## Prose

Comments and docs explain why, not what. A comment earns its place by saying something the code
cannot — the failure it prevents, the measurement behind a constant, the reason an obvious
alternative is wrong. Match the surrounding register; don't restate the next line.
