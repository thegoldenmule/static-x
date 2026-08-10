# Working in this repo

## Commit incrementally

Commit as you go, not once at the end. Each logical step — a piece of shared machinery, a tool, a
fixture, a doc rewrite — is its own commit, made when that step is done and verified rather than
held back until everything is finished. A branch of small commits is reviewable and bisectable; one
large commit at the end is neither, and it loses the record of what was tried.

This does not need asking about each time. Land work in commits by default.

- Conventional Commits, enforced by commitlint: `type(scope): subject`.
- Branch first if on `main`.
- Say *why* in the body, not what the diff already shows — a defect's mechanism, a measurement that
  settled a decision, an option rejected and the reason.

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

## Prose

Comments and docs explain why, not what. A comment earns its place by saying something the code
cannot — the failure it prevents, the measurement behind a constant, the reason an obvious
alternative is wrong. Match the surrounding register; don't restate the next line.

## Checks

`npm run typecheck`, `npm run lint`, and `npx vitest run` all pass before a commit. Fixtures are
excluded from both tsconfig and eslint, so they may hold deliberate problems.
