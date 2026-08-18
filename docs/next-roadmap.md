# Analysis roadmap

[ROADMAP.md](../ROADMAP.md) is closed. Every one of ReSharper's 61 entries now carries a
disposition, and the last two rounds were spent retiring rows with evidence rather than
adding tools. This document is what comes after it, and it is deliberately not a
translation of anything.

The reason the old map ran out is not that it was wrong. It is that it was drawn for C#
before TypeScript existed, by people watching people rewrite C#, and the failures that are
hardest to see *here* have no entry on it. A floating promise, an `any` laundered through a
double cast, an export nothing imports, a `'use client'` directive swallowed by an extract —
none of those are refactorings, and none of them appear on the index. The two live defects
round four found in the *shipped* `extract` tool outranked every row still on the list, and
that ordering is the finding, not an accident of timing.

So this round started from the corpora instead of from a catalogue, and asked one question:
what compiles clean and is wrong? Ten defect classes were nominated and every one of them
was measured — against `tsc` under the corpora's real settings, against ripgrep, against a
population count, and against hand-read precision on real hits.

**Ten candidates, 7,578 raw findings, 41 motivated defects, zero new tools.** The rest of
this document is why, and what the measurement produced instead.

---

## The criterion, and why it is harsher than the refactoring one

A refactoring that is wrong gets refused. `diagnosticsIntroducedBy` typechecks the edit in
memory, any diagnostic the edit introduces blocks the apply, and the cost of a bad analysis
lands on the compiler. That is why [ROADMAP.md](../ROADMAP.md) could rank refactorings on
cross-file reach and guard-decidability and get a usable order out of it.

An analysis tool has no guard. Nothing typechecks a finding. A wrong finding is not refused —
it is *believed*, and its cost lands on the caller's attention. A tool that reports 500
findings of which 5 matter does not cost the caller 495 dismissals; it costs them the 501st
finding too, and the one after that, because a caller who has dismissed twenty findings in a
row does not read the twenty-first. **That is strictly worse than not shipping the tool**, and
it is worse in a way that is invisible from inside the tool, which reports its 5 real defects
correctly and calls itself a success.

So the ranking metric for an analysis tool is **precision, measured by hand on real code,
before the tool exists**. Not correctness — every one of the ten candidates below can be
implemented correctly. Correctness is cheap here and it buys nothing.

**The bar.** A finding at `warning` must be right more often than it is wrong. Below 0.5,
a class ships at `info` or not at all; below roughly 0.2 it must not ship in any form,
because at that rate the caller is doing the analysis and the tool is doing the interrupting.
Measured against those numbers, the ten candidates run from 0 to 0.21, median **0.068**.
Not one came within a factor of two of the bar.

### Five questions, cheapest first

Asked in this order, because the expensive one is last and eight of ten never needed it.

0. **Has this already shipped, here or elsewhere, and been switched off?** Read the corpus's
   own config before writing any code. This is the cheapest measurement in the set and it
   settled three candidates outright. Powerhouse's `tsconfig.options.json` carries
   `noUncheckedIndexedAccess` commented out beside the note *"enabling them on our repo
   produces 1839 errors"*; its `eslint.config.js` enables `recommendedTypeChecked` and then
   explicitly disables the entire `no-unsafe-*` family and `no-unnecessary-type-assertion`
   with the comment *"our overzealous generics force us to do this"*. A tool whose output a
   corpus has already read and declined **in writing** has a measured audience of zero.
1. **Does it compile clean under the corpus's real settings?** If `tsc` already reports it,
   the tool is a worse `tsc`. Three candidates died here — and two of them were nominated
   *as* "compiles under every configuration", which is the point: the nomination step is
   intuition, and intuition about the compiler was wrong three times in ten.
2. **Could grep do it?** [Principle 1](plan.md#guiding-principles), and not as a rhetorical
   question — run the grep and diff it against the AST pass. One candidate's ripgrep pattern
   reproduced the AST answer *exactly*: 83 = 83 empty catches and 43 = 43 empty `.catch()`
   handlers, with identical start lines, per corpus.
3. **Is there a population?** Motivated targets surviving the tool's own refusals, never
   syntactic candidates. This is round four's lesson, and it holds here: `prototype-vs-own-property`
   has 2,062 syntactic sites, 91 checker-confirmed candidates, and 0 defects.
4. **What is the hand-read precision?** Read the hits — a seeded random sample, or better,
   the whole census. Four of the ten assessments below read 100% of their population, and
   those are the zeros worth trusting most.

Eight of ten could have been retired without reading a single finding, had the cheap
questions been asked first. They were all measured anyway, which is why the precision column
exists — but the *ordering* is the reusable part of this round.

---

## What to build

Nothing new. Three items, all of them work on tools that already ship, ranked by what the
measurements say they are worth.

| # | Work | Where | Measured prevalence | Measured precision |
| --- | --- | --- | --- | --- |
| 1 | ✅ Recompute cycle SCCs over the value-edge subgraph | `ts/graph/cycles` | 6 `value` cycle findings across the corpora | **0.00** — none of the 6 had a runtime loop |
| 2 | Record the measured limits in the tool READMEs | `ts/async/floating-promises`, `ts/types/loopholes`, `ts/graph/cycles` | 3 tools with limits nobody can currently see | n/a |
| 3 | ◻ᵗ Assertion soundness classification | `ts/types/loopholes` | 755 of 2,519 assertions are checker-verified | **1.0** on the refusal; 0.11 on what survives it |

Item 1 was a live defect in shipped code and has landed. Re-measuring after the fix moved
its numbers: all **six** value-cycle findings across three projects were false, not four of
five, so the shipped precision of that classification was **0.00** rather than 0.20. Every
runtime-cycle warning those projects received was wrong. The test that should have caught
it asserted the defect by name — "keeps a mixed value/type cycle at warning" — which is
worth more attention than the bug: a test can encode a belief as firmly as code can, and
this one had been green throughout.

Item 3 is conditional with a written trigger and should not be built speculatively. There
is no item 4.

---

## Gaps in shipped tools

These are the round's real output, and they outrank every candidate in the retirement table
below — the same way the `'use client'` and `import('./m.js')` defects in `extract` outranked
every remaining index entry. A defect in a tool that ships is worth more than a tool that
doesn't, because it is currently producing wrong answers that someone may be acting on.

### 1. `ts/graph/cycles` reported value cycles that do not exist at runtime — ✅ fixed

**Fixed.** Components are now computed twice, and a runtime cycle is one that remains
strongly connected using value edges alone. What follows is the diagnosis as it was found,
kept because the shape of the mistake is reusable.

The SCC was computed over the full import graph — every edge, `import type` included — and the
runtime-versus-erased classification was then decided *after the fact*, in
[`cycles.ts`](../ts/graph/cycles/cycles.ts):

```ts
const innerEdges = graph.edges.filter((e) => members.has(e.from) && members.has(e.to));
const typeOnly = innerEdges.every((e) => e.typeOnly);
```

A component held together by `import type` edges contains value edges too — just not a value
*loop*. `every` returns false the moment one inner edge carries a value, so the component is
labelled `value`, reported at `warning`, and described to the caller as making
"initialization order fragile" when nothing in it survives to runtime.

**Measured:** the value-edge-only SCC is empty in all three powerhouse packages. Reactor-browser's
90-file component and reactor-api's 38-file component are both reported as warning-severity
value cycles with no runtime loop at all, and **4 of the 5 `value` findings across the four
corpora are in this class** — a shipped precision of 0.20 on the tool's own headline severity.

Two further consequences fall out of the same line, and both are visible in the finding text.
`groupNote` reports the full-graph component size, so a real value cycle inside a large
type-linked component is described as "part of a strongly-connected group of 90 files" that
does not exist at runtime. And `shortestLoop` walks `innerAdjacency`, which is derived from
the full-graph adjacency, so the loop path printed for a `value` finding can traverse a
`import type` edge — the tool draws a runtime cycle through an edge that is erased.

**The fix, stated precisely enough to build:** run `stronglyConnectedComponents` twice — once
over the full adjacency for `type-only` reporting, once over the value-edge subgraph for
`value` reporting — and derive `groupNote`, `shortestLoop`, and `innerAdjacency` from
whichever graph produced the component. A value component is always a subset of a full-graph
component, so the type-only pass loses nothing.

**The fact that keeps this semantic** is the one the tool already computes and then throws
away. `typeOnly` per edge is decided in `importClauseTypeOnly`
([`import-graph.ts:95`](../ts/graph/import-graph.ts)), which reads the marker off the clause
*or* off every named specifier — `import type { A } from './m'` and `import { type A } from './m'`
are different syntax for the same erased edge, while `import { type A, b }` is a live one
because the statement still emits. And the specifier has to be *resolved* before any of it
counts: an edge exists between two files, not between a file and a string. Grep can find
`import type`; it cannot tell you whether deleting those edges disconnects a 90-file
component, which is the entire question.

**What it deliberately still will not do:** initialization-order analysis. TDZ across a
runtime cycle compiles clean and throws `ReferenceError` — this was probed and confirmed by
executing it, for both a `const` cycle and `class Mixin extends Base` — but the corpora
contain exactly **one** runtime cycle in 1,076 files, and it is benign. Potential and actual
TDZ both measure zero. Do not build an ESM evaluation-order simulator for a population of one.

*(Compiler gotcha worth encoding as a test if anyone revisits this: `ts.isTypeNode()` returns
true for `ExpressionWithTypeArguments`, so a naive type-node bail silently drops
`class X extends Base` — the commonest real TDZ shape. It produced a wrong measurement before
it was probed.)*

### 2. `ts/async/floating-promises` cannot see a promise dropped across a callback boundary

`findFloatingPromisesInFile` visits only expression statements
([`floating-promises.ts:171`](../ts/async/floating-promises/floating-promises.ts)), so an
async function handed to a parameter typed `() => void` is invisible to it — the promise is
dropped by the callee, and there is no expression statement anywhere.

This gap is **real and should not be closed.** It was measured as a candidate in its own
right: 198 callback hits across the corpora, 5 arguably real, precision 0.025. The 191
non-defects are vitest lifecycle hooks and Fastify route registrations — frameworks that *do*
await the promise they are handed, while their types say `=> void`. TypeScript's type system
does not record awaited-ness, so nothing in the checker separates `beforeEach(async …)` from
`setTimeout(async …)`. The only mechanism that does is a hand-maintained per-framework
allowlist keyed on callee name, which is exactly the lexical, unmaintainable thing principle 1
excludes — and is why typescript-eslint's `no-misused-promises` ships `checksVoidReturn` with
a reputation for noise.

The action is one paragraph in the README: state the boundary, state that it was measured at
0.025, and state that the allowlist is the only known closure so the next person does not
re-derive this. The strongest instance found — three async listeners handed to chokidar in
`reactor-api/src/packages/vite-loader.mts:173,192,211`, where a rejection terminates the Node
process — is worth reporting by hand, not worth 193 false positives to catch automatically.

### 3. `ts/types/loopholes` cannot say which of its own assertions assert nothing — ◻ᵗ

`loopholes` grades `as any` and double casts as `warning` and plain assertions as `info`, all
syntactically ([`loopholes.ts:188-224`](../ts/types/loopholes/loopholes.ts)), which its README
correctly says out loud. Across the corpora that is 2,519 assertions.

**What the checker could add:** resolve `getTypeAtLocation(operand)` and
`getTypeFromTypeNode(node.type)` and ask `isTypeAssignableTo` in *both* directions. Source
assignable to target is an upcast; assignable both ways is an identity cast. In neither case
does the assertion override anything the checker would not already have concluded, so the
finding is reporting a syntax the author used redundantly rather than a hole in the type
system. Measured: **755 of 2,519 — 568 upcasts and 187 identities, 30%.** That refusal has
precision 1.0 by construction; the checker proves each one.

**Why it is conditional and not scheduled.** Three reasons, and they compound. The findings it
would remove already ship at `info`, so a caller filtering on severity never saw them. The
1,764 that survive are no better than what ships today — a seeded random sample of 18 drawn
from the 473 in production code contained 2 real defects, 4 counting borderline ones, so
0.11–0.22. And `isTypeAssignableTo` is not on the public `ts.TypeChecker` type; it is present
at runtime in TS 5.9.3 and was verified there, but consuming it means `loopholes` carries a
cast through an undocumented API in order to reduce its own `info` volume by 30%. That is not
obviously a trade worth making unprompted.

**The written trigger:** build it when someone reads `types.assertion` output at volume and
asks for the ranking, or when a second tool needs bidirectional assignability — at which point
the undocumented-API risk is shared rather than speculative, and the classifier is a few dozen
lines. This is the same discipline `copy-type` is held to in [ROADMAP.md](../ROADMAP.md#move).

**What is explicitly declined:** the sharper rule the same investigation built — *target has
required properties the source provably lacks*, via `getPropertiesOfType` filtered by
`SymbolFlags.Optional`. It is genuinely semantic and genuinely unavailable to grep, and it
fires 41 times in production across 951 files for 3 real defects. Twenty-five of the 38
non-defects are one mechanical pattern in a single generated file
(`reactor-api/src/graphql/reactor/gen/graphql.ts`), where a `Promise<X> | AsyncIterable<X>`
union reads as an empty source type. Ignoring that file leaves 16 findings and 3 defects —
0.19, below the bar, and the bar is the point of this document.

Its best hit is worth recording, because it is the shape the rule exists for and it is still
not worth 38 false positives:
`reactor-browser/src/graphql/adapters.ts:64` asserts a locally-built object literal to
`PHDocumentHeader` when the literal has no `sig` and no `revision`, both required — so every
consumer reading `header.revision` gets `undefined` at a type that promises a value. `tsc` is
silent because a single assertion is only TS2352 between types that do not *sufficiently
overlap*, and a subset overlaps fine.

---

## What was retired, and what killed it

Five reasons, one per gate question. The brief for this round named four; the fifth —
*already shipped* — is the one [ROADMAP.md](../ROADMAP.md#round-four-and-what-closed-the-index)
had already discovered independently, when Encapsulate Field turned out to be `member-form`
with `to: "accessor"`. It is the most common killer here too.

| Candidate | Raw | Motivated | Precision | Killed by |
| --- | --- | --- | --- | --- |
| `unsound-assertions` | 3,012 | ~3 | 0.11 | **Already shipped** — every instance is emitted today by `ts/types/loopholes` |
| `prototype-vs-own-property` | 2,062 | 0 | 0 | **No population** — 91 checker-confirmed candidates, 0 defects |
| `unchecked-index-access` | 1,779 | ~26 (est.) | 0.21 | **Already shipped** — `tsc --noUncheckedIndexedAccess`, declined in writing by the corpus |
| `missing-await-non-floating` | 220 | 5 | 0.068 | **Bad precision** — 191 of 198 callback hits are frameworks that do await |
| `shared-mutable-module-state` | 210 | 0 | 0 | **No population** — 0 `export let` in 1,076 files; 0 cross-file mutations |
| `error-handling-lies` | 191 | 3 | 0.068 | **Grep would do it** — ripgrep reproduces the AST set exactly, 83 = 83 and 43 = 43 |
| `equality-and-identity` | 35 | 1 | 0.029 | **Bad precision** — 22 of 23 object `===` are deliberate identity comparisons |
| `react-hook-and-effect-hazards` | 36 | 2 | 0.09 | **Already shipped** — eslint-plugin-react-hooks 7.1.1, already a devDependency |
| `promise-in-condition` | 22 | 0 | 0 | **Compiles not clean** — TS2801 under `strictNullChecks`, which all four corpora set |
| `non-exhaustive-union` | 11 | 1 | 0.09 | **No population** — 24 `switch` statements in 951 files, 14 already exhaustive |

Four of these deserve their mechanism recorded, because each one changed the answer rather
than confirming it.

**`promise-in-condition` is the sharpest result in the set, and it is a trap.** The candidate's
premise — "compiles under every configuration" — is false: TypeScript ships TS2801 as an
*error*, covering `if (p)`, `p ? a : b`, and both operands of a logical chain in a condition.
The residual gap is real (`!p`, `while (p)`, `Boolean(p)`, `??`-left, and TS2801's own
`isUsed` suppression at `typescript.js:88048`) and it is empty: 0 always-truthy promises across
9,430 boolean-position expressions in 1,036 files. All 22 raw candidates were read; 18 are
`Promise<T> | undefined` lazy-init guards and 4 are React 19's `ReactNode`, whose union
contains `Promise<AwaitedReactNode>`. Then the interaction that settles it — the tool's value
is confined to `strictNullChecks: false` projects, and with that flag off `Promise<T> | undefined`
collapses to `Promise<T>`, so the *only* configuration where the tool has a job is the one
configuration where it structurally cannot tell a defect from a correct guard. It would flag
all 18 guards and find nothing. There is no third setting.

**`equality-and-identity` flags its own cure.** Two of its three sub-classes are unconditional
compiler errors — TS2845 for NaN, TS2839 for an object literal operand — and their silent
escape hatches (`Number.NaN`, a parenthesized literal, an `as`-wrapped literal,
`x === structuredClone(x)`) have a combined corpus incidence of zero, as does `Object.is`. The
residue is object-typed `===`, and all 35 hits were read: 34 are deliberate identity
comparison — cache-staleness re-checks, listener deregistration, linked-list traversal,
`e.target === e.currentTarget`. The decisive detail is that the two hits most resembling the
classic React array-identity bug (`wallet-registry.ts:94`, `wallet-provider.tsx:122`) are code
written specifically to *detect and warn about* that bug. A tool here flags the fix.

**`error-handling-lies` is the cleanest grep verdict this repo has produced.** The "lies" half
is a compile error: all four corpora are `strict: true`, so `useUnknownInCatchVariables` forces
narrowing, and across 505 catch clauses the number of bindings touched as an `Error` without
proof is 2 — both `catch (error: any)` in one test file, and both already reported by
`loopholes`. The swallow half compiles clean but is lexical, and this was measured rather than
argued: one multiline ripgrep reproduces the AST empty-catch set exactly, with identical start
lines. And the reason there is no semantic signal left is itself measured — 82 of 83 empty
catches carry a comment, because ESLint's `no-empty` exempts comment-bearing blocks and has
already trained the corpus to mark every deliberate swallow lexically.

**`unchecked-index-access` is a compiler flag wearing a tool's clothes.** Forcing the flag on
in memory produced 1,779 new diagnostics, independently corroborating the 1,839 the corpus
owner wrote into their own tsconfig when they rejected it. 874 of the 1,109 in-package hits
(79%) are test files where `expect(xs).toHaveLength(1)` sits directly above `xs[0]`. The only
thing a tool could add over the flag is suppression of provably-safe accesses — and that is
not a checker query at all but an abstract interpreter: loop-bound value ranges, guard
dominance across *derived* expressions (`packageNames.sort()[0]` guarded by
`packageNames.length === 0` defeats any base-text match), `in`-then-assign flow,
`Object.keys` provenance, plus lib facts like `String.split()` never returning empty. The
prototype filter suppressed 92 of 235 production rows and both over- and under-fired.
Sermon-search, which has the flag on, yields literally zero.

### Numbers I do not trust as far as they are stated

Flagged rather than averaged over. None of these changes a verdict; all of them would change a
comparison.

- **`unchecked-index-access`, motivated ≈ 26.** This is an extrapolation — 0.21 precision
  applied to 124 distinct surviving sites — not a tally. Every other motivated count in the
  table is hand-read. It is also the single largest contributor to this document's headline
  "41 motivated defects"; the hand-verified total across all ten candidates is **22**. Do not
  put the two numbers on the same axis.
- **`missing-await-non-floating`, precision 0.068.** Computed as 5 of 74 read, but the 74 were
  drawn deliberately to exclude vitest lifecycle hooks. Against the full 220 population the
  rate is closer to 0.023. The favourable denominator is the one reported.
- **`unsound-assertions`, motivated 3.** Two samples yield four *distinct* real defects with
  one shared between them, and the example list names five with two marked borderline. The
  true figure is somewhere in 2–5, and the borderline calls move the sampled precision by 2×
  (0.11 → 0.22). Quote the range, not the point.
- **`unsound-assertions`, raw 3,012.** Three syntactic families summed, but only the 2,519
  assertions were ever examined by the semantic classifier. Against the best sub-rule the
  honest denominator is 41.

---

## Findings to hand back, not tools

The round's other yield. Each of these is a real defect found *by* the measurement, in a
corpus, and none of them justifies a tool.

**Verification status matters here, because these are claims about someone else's production
code.** They were found by automated analysis during the survey. Two were re-read by hand and
confirmed: the `watchFile` guard below (`curr.mtime` and `prev.mtime` are distinct `Date`
objects, so `===` compares identity and can never be true — `mtimeMs` is the comparison that
was meant), and the `sig.split(", ") as Signature` assertion. The rest are unconfirmed and
should be read before anyone acts on them.

| Finding | Where |
| --- | --- |
| ✔ verified — `curr.mtime === prev.mtime` in a `watchFile` listener compares two distinct `Date` objects by identity, so the early-return guard is dead and cannot filter anything | `powerhouse/packages/reactor-api/src/packages/package-manager.ts:356` |
| Three async listeners handed to chokidar's `.on("change", …)`; a rejection is unhandled and terminates the process | `powerhouse/packages/reactor-api/src/packages/vite-loader.mts:173,192,211` |
| `handleRemoved` omits the third `MailboxType` member while `handleAdded` handles it, and `trackRemote` never subscribes `deadLetter.onRemoved` — `errorCount` can only increase, so a document pins at `SyncStatus.Error` | `powerhouse/packages/reactor/src/sync/sync-status-tracker.ts:148` |
| ✔ verified — `sig.split(", ") as Signature`: `string[]` asserted to a 5-tuple with no length check, against the function's own JSDoc | `powerhouse/packages/reactor/src/sync/channels/utils.ts:99` |
| A validator crashes on `specifications[0]` for exactly the malformed input it exists to reject | `powerhouse/packages/reactor-browser/src/utils/validate-document.ts:20` |
| Two `rules-of-hooks` violations, silent today only because `eslint.config.js` scopes its React block to `files: ["**/*.tsx"]` while reactor-browser is a hooks library with 241 `.ts` files against 21 `.tsx` | `reactor-browser/src/hooks/selected-document.ts:60`, `src/hooks/theme.ts:97` |

The last row is the best return-on-effort in the entire round: adding `"**/*.ts"` to one glob
in `powerhouse/eslint.config.js` takes the corpus's already-installed linter from 1
react-hooks finding to 24, including both real defects, and static-x builds nothing.

---

## What this does not cover

**Four projects from two organizations is a narrow evidential base**, and every "zero" above
is corpus-relative. `powerhouse/packages/{reactor,reactor-api,reactor-browser}` and
`sermon-search` are all recent, all `strict: true`, all linted with type-aware rules, and all
Node-plus-React service monorepos. They are not a sample of TypeScript; they are a sample of
*well-maintained modern* TypeScript, and several candidates died specifically because those
adjectives hold. `unchecked-index-access` yields zero on sermon-search only because the flag
is on there. `error-handling-lies` has no semantic residue only because ESLint's `no-empty`
already trained the corpus to comment its deliberate swallows. A legacy codebase, a
JS-to-TS migration, a library with a wide public API surface, or anything at `strict: false`
would score differently — though note that `promise-in-condition` measured *worse* under
`strict: false`, not better, so "a looser corpus would revive these" is a hypothesis and not a
safe assumption.

**Hand-adjudicated precision is the instrument, and it has no inter-rater check.** One reader
decided what counted as a defect in code they did not write. The word "borderline" appears in
several samples and moves the sampled precision by 2× where it does. The zeros from complete
censuses — `promise-in-condition` 22/22, `equality-and-identity` 35/35, `non-exhaustive-union`
11/11, `prototype-vs-own-property` 91/91 — are the most trustworthy results here, and it is
worth preferring a census over a sample whenever the population is small enough to allow it.

**The nomination step was never measured.** All ten candidates came from intuition about what
compiles clean and is wrong, and that intuition was wrong about the compiler in three cases
out of ten — including two nominated explicitly as compiling under every configuration. A
better instrument is available and was not used: mine the corpora's own `git log` for
bug-fix commits, read what each one actually fixed, and let the defect classes fall out of
that. That nominates from evidence rather than from appeal, it produces a prior on prevalence
for free, and it would have retired at least `prototype-vs-own-property` and
`shared-mutable-module-state` before either cost a probe. **That is how this round should be
redone.**

**What a revisit should carry forward.** Not the ten verdicts — the retirement table is
evidence, not doctrine, and a different corpus can overturn any row in it. Carry forward the
gate ordering, the bar, and the accounting convention round four wrote down: a `targetCount`
is motivated targets surviving the tool's own refusals, never syntactic candidates. Nine of
the ten candidates would have looked healthy on syntactic counts. That is what a syntactic
count is for.

## Swift, cut with the measurement

Considered while building `swift/comments`, and rejected on a count rather than on taste. Each was
measured over 679 files across hotseat-app, drum/ios and War.

- **`<doc:Article>` DocC links** — 0 occurrences. Nothing to resolve.
- **Extended regex literals `#/…/#`** — 0 occurrences. The comment range source handles them because
  the compiler does; nothing needed writing.
- **`workspace/symbol` as a resolution tier** — needs an index store, which needs a build. Every
  shipped Swift tool answers without one, and that property is what keeps a Swift pre-commit hook
  affordable; a tier that gave it up would have to earn it.
- **A hand-written Swift comment lexer** — cancelled outright. `semanticTokens/full` reports every
  comment form, marks doc comments, and classifies comment-like text in strings, raw strings and
  interpolation correctly, on a directory with no project file, in 52ms. See
  [the roadmap](swift-roadmap.md#2-the-obstacle-that-was-expected-and-is-not-there).

