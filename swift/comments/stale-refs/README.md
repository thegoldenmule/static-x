# swift/comments/stale-refs

References in comments that no longer resolve: a DocC link or backtick span naming a symbol nothing
declares, a file reference to a file that is gone, or a `- Parameter` tag naming no parameter of the
function it documents.

Nothing here needs a build. Resolution runs off the same semantic tokens the rest of the comment
family reads, plus a committed index of the Swift and Apple SDK names.

## The resolution corpus

The TypeScript tool resolves a comment's candidate references against scope symbols, a project-wide
declared-name index, string-literal vocabulary, keywords, and JavaScript's builtins by reflection.
Each tier has a Swift analogue, and the tiers are what make this worth writing rather than grepping.

| TypeScript tier | Swift analogue |
| --- | --- |
| `getSymbolsInScope` at the comment | **Dropped.** `completion` per comment is ~3,000 requests on one corpus. What it uniquely contributed was parameter names, which the `- Parameter` owner analysis already computes. |
| `declaredNames` over the project | `documentSymbol` swept over `sourceFiles()` — SwiftSyntax-backed, needs no build — with a lexical scan over comment- and string-masked text as the fallback |
| `literalVocabulary` | String literals, free from the same semantic tokens the comment ranges come from, plus enum case names |
| `TS_KEYWORDS` | A Swift keyword set |
| `BUILTIN_MEMBERS` by reflection | **Generated data.** Swift has no runtime to ask, so `swift-symbolgraph-extract` over Swift, Foundation, SwiftUI, UIKit and friends, committed as JSON with the toolchain version in its header |
| — | **Imported module names**, harvested project-wide. Without this tier `SwiftUI` and `MusicXML` are reported stale |

`.swiftinterface` was tried first and rejected: 7,575 names across five modules, but Objective-C
imported API has none, which left `UserDefaults`, `URLSessionDataTask`, `WKWebView` and `NSError`
reported as stale in all three corpora. `swift-symbolgraph-extract` covers clang modules with one
invocation.

## Extraction, and the two passes that pay for themselves

Ordered passes, each blanking what it matched so a later pass cannot re-match it: URLs, DocC
parameter tags, DocC symbol links, backtick code spans, file references, then bare tokens.

- **URL blanking, first.** Without it War reports 502 unresolved bare tokens, dominated by
  `github.com` and `https`. With it, and the tiers above: **502 → 84.**
- **Whole-path file references.** Matching the trailing basename instead of the whole path token
  produced 18 of hotseat-app's 20 file findings out of `~/.hotseat/config.json`-shaped strings. One
  rule removes all 18.

## `- Parameter`, and the label-versus-name decision

Swift declares both an argument label and an internal parameter name (`func f(for name: String)`).
A doc tag must be accepted if it matches **either**, and flagged only when it matches neither.

| Corpus | Documented params | Label and name differ |
| --- | ---: | ---: |
| hotseat-app | 3,006 | 203 (6.8%) |
| drum/ios | 574 | 106 (18%) |
| War | 1,608 | 410 (25%) |

Requiring the label false-positives on every comment naming the internal name — up to a quarter of
them. Requiring the name false-positives on every comment following Apple's own convention.
Requiring both is worse than either. Accepting either costs only the case where a writer swapped two
parameters, which is vanishingly rare against a 6.8–25% floor — and this code would be in
`SWIFT_FIXABLE_CODES`, where an agent acts on it unattended.

Mirror the TypeScript guard too: if any parameter has a form the text parse cannot resolve
confidently, compute no list and skip validation rather than guess.

## What it reports

| Corpus | Files | Findings | At `minConfidence: medium` |
| --- | ---: | ---: | ---: |
| hotseat-app | 204 | 115 | 70 |
| drum/ios | 82 | 6 | 0 |
| War | 393 | 62 | 1 |

The TypeScript tool reports 234 → 132 on this repository, so this is the quieter of the two. It sits
in `push` at `warn` with `minConfidence: medium`.

`baseline` rather than `changed-lines`, and the reason is the same one that puts
`graph/dead-exports` there: a rename in one file stales a comment in another, so the commit that
broke the reference need not have touched the file the finding lands in.

### Input

| Field | Type | Meaning |
| --- | --- | --- |
| `extraRoots` | string[] | Other Swift projects whose declared names also count as resolving |

`extraRoots` opens a real session on each root, so the names come from the same compiler
classification as this project's. A root that does not bind throws rather than contributing nothing
— an ignored `extraRoot` would look exactly like one whose names did not help.

The measured need for it is concrete: hotseat-app's comments say *"Mirrors `applyWorktreeEvent` in
mastra-hotseat"* half a dozen times, naming a sibling repository. Those are true positives without
it and resolvable with it.

## Cut, with the count as the reason

`<doc:Article>` links: **0 occurrences** in 679 files. Extended regex literals `#/…/#`: **0**.
`workspace/symbol`: needs an index store, which needs a build, which this pack does not require.
