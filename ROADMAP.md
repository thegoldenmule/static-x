# Refactoring roadmap

[ReSharper's refactoring index](https://www.jetbrains.com/help/resharper/Refactorings__Index.html) is the most complete catalogue of code transformations any tool ships — 61 named refactorings, accumulated over twenty years of watching people rewrite C#. This document translates every one of them into TypeScript and into this repo's tool contract, so the set of refactorings static-x should own is a decision already made rather than one taken a tool at a time.

The 61 entries collapse to **39 TypeScript tools**; **10 have no TypeScript meaning at all**, and saying precisely why is part of the translation. **Twenty-one are shipped, covering twenty-seven index entries** — see the ✅ rows below.

## Translating a refactoring

Three things change when a refactoring moves from an IDE to a tool an LLM calls.

**There is no caret.** ReSharper's inputs are the selection and the cursor. Ours have to be written down, and which addressing form a refactoring can accept decides much of its design:

| Addressing | The caller supplies | Example |
| --- | --- | --- |
| `symbol` | A declaration name, optionally disambiguated by file or exact position | `{"symbol": "makeOptions"}` |
| `select` | The exact code to act on, located by parsing rather than by offsets | `{"select": "a.qty * a.unit"}` |
| `file` | A path | `{"file": "src/lib.ts"}` |
| `range` | A file plus start/end line and character | `{"file": "…", "startLine": 12, …}` |

Symbol addressing is what an LLM produces reliably; range addressing is what it produces by counting characters, which it cannot do. That difference is a ranking criterion below, not a footnote — a tool that accepts an approximate range and returns a confident answer for the wrong code is worse than no tool.

**Analysis and mutation never mix.** Refactorings return an LSP-compatible `WorkspaceEdit` keyed by absolute path, dry-run by default, writing only with `apply: true`. They take no `files` scope: a partial file list would mean a partial refactor, and the ferry [refuses it](ts/ferry/ferry.ts) for every tool whose output isn't a finding array.

**The guard is the product.** Before writing, the project is typechecked in memory with the edit applied, and any diagnostic the edit *introduces* refuses it — the mechanism [`rename`](ts/refactors/rename/rename.ts) already uses. Where that guard is a complete oracle, a refactoring is trustworthy no matter how naive its analysis. Where the failure mode is code that still compiles and now means something else, the guard is silent, and the tool has to say so out loud. Each entry below is ranked partly on which of those two it is.

**Status legend.** ✅ shipped · ◻ specified, unbuilt · ✖ no TypeScript meaning.

---

## The first five — shipped

Chosen for the three things that make a refactoring worth a *tool* rather than a text edit: it rewires references across files the caller never opened; its precondition is whole-project knowledge; and its correctness is decidable by the guard rather than merely hoped for.

| # | Tool | From | Why first |
| --- | --- | --- | --- |
| 1 | [`ts/refactors/move-symbol`](ts/refactors/move-symbol/README.md) | Move Type to Another File | The canonical fix for a god-module, and the edit an LLM cannot make: every importer's specifier, in files it never read. TypeScript's own refactoring engine does the hard part. |
| 2 | [`ts/refactors/safe-delete`](ts/refactors/safe-delete/README.md) | Safe Delete | The guard at its strongest — a missed reference is a hard `TS2304`, not a shape change. Completes the story `ts/graph/dead-exports` starts: that tool finds, this one removes. |
| 3 | [`ts/refactors/move-file`](ts/refactors/move-file/README.md) | Move to Folder | In TypeScript the folder *is* part of a module's identity, so moving a file is a project-wide edit by construction. Addressed by two paths — no caret problem exists. |
| 4 | [`ts/refactors/inline-parameter`](ts/refactors/inline-parameter/README.md) | Inline Parameter | "Every caller passes the same value" is exactly the knowledge one file cannot contain. The first tool that *authors* call-site edits instead of borrowing TypeScript's. |
| 5 | [`ts/refactors/make-readonly`](ts/refactors/make-readonly/README.md) | Make auto-properties get-only | The one place the guard is provably complete: a write that blocks `readonly` surfaces as `TS2540` at its own location, so even a wrong analysis cannot ship a wrong edit. |

Each behavior these rely on was measured against the vendored TypeScript before being coded against. Some of what turned up: TypeScript's engine *throws* rather than refusing for a target it cannot handle; a caret offset moves every statement in the file, so `move-symbol` passes a statement range; a barrel re-export left pointing at the old module is a hard error, so without redirecting it no symbol in a barrelled project can move at all; and the argument for a parameter is not at its positional index once a `this` parameter or an omitted optional is involved.

### Why Extract Method wasn't among them

It is the most famous refactoring on the list and it was deferred deliberately, because it is addressed by range and an approximate range yielded a confident wrong answer. The mechanism, since found: `getRangeToExtract2` takes an `invoked` flag that decides whether it snaps the given span out to node boundaries. The applicability path passes `triggerReason === 'invoked'`; the edits path passes nothing, and the parameter **defaults to true**. So the two disagreed, and TypeScript could refuse a target while still producing a confident edit for a neighbouring one. Verifying a fix against `getApplicableRefactors` alone would have made the bug invisible.

Both halves are now closed. `applicableActions` passes `'invoked'`, so the paths adjust identically, and `runRefactor` asks whether a refactoring applies before asking for its edits. What remains is not to hand the engine an approximate range at all: ranges derived from parsed candidates already sit on node boundaries, which makes the adjustment a measured no-op.

`change-signature` was deferred for the opposite reason — the guard cannot see its characteristic failure, since a reordered parameter of compatible type compiles green and misbehaves. That reasoning still holds for the positional form, which is why the [next round](#the-next-five) ships only the options-object form, where the trap cannot exist because arguments become named.

---

## The complete index

### Rename and delete

| Status | ReSharper | Tool | In TypeScript | Addr. |
| --- | --- | --- | --- | --- |
| ✅ | Rename | `ts/refactors/rename` | A declaration and every reference project-wide — imports, re-exports, property accesses, shorthand properties, JSX tag names. | symbol |
| ✅ | Safe Delete | `ts/refactors/safe-delete` | Deletes a declaration only after proving nothing references it, then cleans up what the deletion orphans: unused imports, barrel re-export lines, files that become empty. | symbol |

### Move

| Status | ReSharper | Tool | In TypeScript | Addr. |
| --- | --- | --- | --- | --- |
| ✅ | Move Type to Another File | `ts/refactors/move-symbol` | Moves a top-level declaration into another file, existing or created, exporting it if needed and rewriting every importer's specifier. TS files hold many declarations with no name/file correspondence rule, so this is the god-module fix. | symbol |
| ✅ | Move Type to Another Namespace/Module | `ts/refactors/move-symbol` | Not a distinct operation: a TypeScript module *is* a file, and a type's "namespace" is exactly the specifier importers write. Changing it means moving the declaration — the same tool. | symbol |
| ✅ | Move to Folder | `ts/refactors/move-file` | Moves a file and rewrites every specifier that resolves to it, plus the moved file's own relative specifiers. C# links folder and namespace only by convention; TypeScript makes the path part of the module's identity. | file |
| ✅ | Move to Another Type | `ts/refactors/move-member` | Moves a static member or module-level binding to another container. The idiomatic TS destination is usually a plain exported function — modules already provide the namespacing C# needs static classes for, and free functions tree-shake. | symbol |
| ◻ | Move Instance Method | `ts/refactors/move-instance-method` | Feature-envy surgery: moves a method onto the class of one of its parameters, flipping the receiver so `a.m(b, c)` becomes `b.m(a, c)`. Ports unchanged — TS classes carry state and prototype methods exactly as C# types do. | symbol |
| ◻ | Move Type to Outer Scope | `ts/refactors/move-to-outer-scope` | Lifts a declaration nested in a function body or `namespace` block out to module scope. TS nesting is *lexical*, not the C# nested-type kind, so the inner declaration may close over the outer scope's variables and type parameters — that capture is the hard part. | symbol |
| ◻ | Copy type | `ts/refactors/copy-type` | Duplicates a class, interface, alias, or enum into another file under a new name, rewriting self-references and adding the imports the copy needs, leaving existing references on the original. | symbol |

### Extract

| Status | ReSharper | Tool | In TypeScript | Addr. |
| --- | --- | --- | --- | --- |
| ✅ | Extract Method | `ts/refactors/extract` | Lifts a statement range or expression into a new function, computing parameters and return value from data flow through the selection. Async-ness, captured generics, and `this` usage propagate into the signature. Addressed by the code itself, not by offsets. | select |
| ✅ | Introduce Variable | `ts/refactors/extract` | Lifts an expression into a `const` in an enclosing scope — a *scope* of the same operation as Extract Method rather than a separate refactoring, which is why one tool covers both. | select |
| ◻ | Introduce Variable for Substring | `ts/refactors/extract-variable` | Extracts part of a string literal, which in TypeScript means converting to a template literal and referencing the binding as `${name}` — one idiomatic answer where C# offers concatenation or `string.Format`, and an escape-aware conversion rather than a text edit. | range |
| ✅ | Introduce type alias | `ts/refactors/extract-type` | Lifts a type expression into a named `type X = …`. Shipped by TypeScript itself as `refactor.extract.type`. | range |
| ✅ | Convert Anonymous to Named Type | `ts/refactors/extract-type` | C# anonymous types are *values*; the TypeScript analogue is the anonymous *type*. The half worth building beyond TypeScript's own action is `dedupe` — replacing every structurally identical inline occurrence project-wide. | range |
| ◻ | Introduce typedef | `ts/refactors/extract-type` | The same extraction emitting a JSDoc `@typedef`, meaningful only in a `.js` file under `checkJs`. TypeScript ships it as `refactor.extract.typedef`. | range |
| ✅ | Introduce Field | `ts/refactors/extract` | Hoists an expression into a class property, offered as the "readonly field" scope. TypeScript has no field/property distinction — one member kind with `readonly`, `private`, and `#name` as modifiers — so this is "introduce class property" plus a placement decision C# doesn't face. | select |
| ✅ | Introduce Parameter | `ts/refactors/introduce-parameter` | Turns an expression inside a function into a new parameter, passing the original expression at every call site. Structural typing makes the function's *type*, not just its declaration, part of the blast radius. | range |
| ✅ | Extract Interface | `ts/refactors/extract-interface` | Generates an interface from a class's public members and adds `implements`. Structurally, that clause is a documented assertion rather than a requirement — consumers already accept the shape — so the half that buys anything is rewriting use sites from `C` to `I`. | symbol |
| ◻ | Extract Superclass | `ts/refactors/extract-superclass` | Pulls members into a new base class. The cheapest member-move in the family: inheritance preserves every call site, so there is no project-wide reference rewrite at all. | symbol |
| ◻ | Extract Class | `ts/refactors/extract-class` | The god-class split — members into a new class held by a private field, `this.m()` rewritten to `this.helper.m()`, with delegating stubs or a project-wide call-site rewrite. | symbol |
| ◻ | Move to Resource | `ts/refactors/extract-string-constant` | No resource file exists to move to; the surviving intent is hoisting a literal into a shared exported `const`. Needs a compiler because of literal types: `const MSG = 'ok'` keeps the type `'ok'`, but the same literal in an object property widens to `string` and silently breaks narrowing at the use site. | range |

### Inline

| Status | ReSharper | Tool | In TypeScript | Addr. |
| --- | --- | --- | --- | --- |
| ✅ | Inline Parameter | `ts/refactors/inline-parameter` | When every call site passes the same value, drops the parameter from the signature and every call and introduces the value in the body. Also covers the TS shape where a defaulted parameter is never overridden. | symbol |
| ✅ | Inline Variable | `ts/refactors/inline-variable` | Replaces every read of a `const` with its initializer. The one entry TypeScript already implements outright, as `refactor.inline.variable`. | symbol |
| ✅ | Inline Method | `ts/refactors/inline-function` | Substitutes a function's body at its call sites and deletes it. Applies to all three TS callable forms; needs a precedence-aware expression printer the repo doesn't have yet, and re-evaluates side effects when an impure argument appears twice. | symbol |
| ✅ | Inline type alias | `ts/refactors/inline-type-alias` | Substitutes an alias's right-hand side at every use — `type Id = string \| number` used as `Id[]` becomes `(string \| number)[]`. C# inlines a `using X = …` directive; TS aliases are generic, conditional, and mapped, so the TS form does strictly more. | symbol |
| ◻ | Inline typedef | `ts/refactors/inline-type-alias` | The same operation over the JSDoc declaration form. TypeScript has no `typedef` keyword. | symbol |
| ◻ | Inline Field | `ts/refactors/inline-field` | Replaces reads of a never-reassigned class property with its initializer. Splits from the local-variable case, which TypeScript already covers. | symbol |
| ◻ | Inline Class | `ts/refactors/inline-class` | Folds a single-consumer class back into its consumer, rewriting `this.helper.m()` to `this.m()`. | symbol |

### Signature

| Status | ReSharper | Tool | In TypeScript | Addr. |
| --- | --- | --- | --- | --- |
| ◻ | Change Signature | `ts/refactors/change-signature` | Adds, removes, reorders, retypes, or defaults parameters and updates every call site — across overload lists, interface signatures, and every override in the hierarchy. The highest-value entry in the index; the [next round](#the-next-five) ships the options-object form, where its characteristic trap cannot exist. | symbol |
| ✅ | Transform Parameters | `ts/refactors/change-signature` | TypeScript has no `ref`/`out`, so the C# headline feature has no counterpart — you return a tuple or an object instead. What survives is the general parameter-list edit, plus a TS-native flavor: collapsing a long positional list into a destructured options object and back. | symbol |
| ◻ | Add/Remove params modifier | `ts/refactors/rest-parameter` | Toggles the last parameter between `f(xs: T[])` and `f(...xs: T[])`, rewriting each call site's argument shape. TS rest parameters type more than C# `params` does — they may be tuples with labeled and optional elements. | symbol |
| ✅ | Invert Boolean | `ts/refactors/invert-boolean` | Negates a boolean's returns and assignments and every read of it, optionally renaming. Sound only when the checker says the type is exactly `boolean`: truthiness coercion means `!x` is not an inversion for anything wider. | symbol |

### Members and hierarchy

| Status | ReSharper | Tool | In TypeScript | Addr. |
| --- | --- | --- | --- | --- |
| ✅ | Make auto-properties get-only | `ts/refactors/make-readonly` | TypeScript has no auto-properties, so the equivalent is `readonly` on a property nothing writes outside its initializer or constructor. The precondition is a project-wide write query — which is the whole value. | symbol |
| ◻ | Encapsulate Field | `ts/refactors/encapsulate-field` | A public property becomes a private backing field plus a `get`/`set` pair. Unlike C#, no call site changes and assignability is unaffected — `obj.foo` reads identically either way — so the point is inserting a hook, not source compatibility. | symbol |
| ✅ | Convert Property to Auto-Property | `ts/refactors/member-form` | Collapses a `get`/`set` pair that only reads and writes one backing field into a plain property. A getter with no setter becomes `readonly`. | symbol |
| ✅ | Convert Method to Property | `ts/refactors/member-form` | A zero-argument `getFoo(): T` becomes `get foo(): T` — or a `readonly` field when the body is constant — rewriting every `x.getFoo()` into `x.foo`. | symbol |
| ✅ | Convert property to method(s) | `ts/refactors/member-form` | The reverse: reads `o.x` become `o.getX()`, writes `o.x = v` become `o.setX(v)`. | symbol |
| ✅ | Make Method/Property Static | `ts/refactors/static-form` | Adds `static` to a member that never touches instance state and rewrites `instance.m()` to `Class.m()`, importing the class where needed. A `this`-free method is the strongest signal a member doesn't belong to the instance. | symbol |
| ✅ | Make Method Non-Static | `ts/refactors/static-form` | Drops `static` and promotes a parameter to the receiver. TypeScript adds a wrinkle C# lacks — the explicit `this` parameter — though the idiomatic TS move is usually the opposite direction. | symbol |
| ◻ | Pull Members Up | `ts/refactors/pull-members-up` | Moves members into a base class, or pulls up only the signature when the target is an interface, since TS interfaces hold no implementations. | symbol |
| ◻ | Push Members Down | `ts/refactors/push-members-down` | The mirror. The subclass set isn't knowable from the base: `ts.Program` has no reverse-inheritance index, so the tool must scan heritage clauses project-wide and resolve each `extends` through the checker. | symbol |
| ◻ | Replace Constructor with Factory Method | `ts/refactors/constructor-to-factory` | Makes the constructor `private` and introduces a factory, rewriting every `new Class(…)`. The TS motivation is stronger than C#'s: constructors cannot be `async`, so factories are how you build objects that need to await. | symbol |
| ✅ | Use Base Type Where Possible | `ts/refactors/widen-type` | Replaces an annotation with the least specific type that still typechecks everywhere. Structural typing makes the TS version strictly more powerful: the candidate isn't limited to declared ancestors — any structural supertype qualifies, including one synthesized from exactly the members the code touches. | symbol |

### Declaration form

| Status | ReSharper | Tool | In TypeScript | Addr. |
| --- | --- | --- | --- | --- |
| ◻ | Convert Abstract Class to Interface | `ts/refactors/class-interface-form` | Drops the runtime shell and rewrites `extends` to `implements` at every subclass. The tool is its guards: an interface has no runtime existence, so `instanceof`, `typeof`, DI registration, `super(…)`, and decorators are all fatal, and interfaces hold no `private`, `static`, or implemented members. | symbol |
| ◻ | Convert Interface to Abstract Class | `ts/refactors/class-interface-form` | The same tool run backwards. | symbol |
| ✅ | Convert to scoped enum | `ts/refactors/enum-to-const-object` | TS enum members are already qualified, so the transferable half is the strictness: a numeric `enum` becomes a string enum, or an `as const` object plus a union type — losing the reverse mapping, the numeric assignability, and the runtime object. | symbol |
| ◻ | Convert Indexer to Method | `ts/refactors/index-access-form` | TS has no indexer *member* — only an index *signature*, which has no body, while `obj[k]` is ordinary dynamic property syntax. The transferable refactor replaces the signature with `get`/`set` methods and rewrites accesses. | symbol |
| ◻ | Convert Method to Indexer | `ts/refactors/index-access-form` | The reverse: a trivial `get`/`set` pair collapses into an index signature. | symbol |
| ◻ | Convert to Non-Global Using | `ts/refactors/globals-to-imports` | Replaces reliance on an ambient global with the explicit import each referencing file needs, deleting the `declare global` or converting a `namespace` into a module. | symbol |
| ✅ | Introduce Namespace Alias | `ts/refactors/module-form` | C#'s `using X = Some.Long.Namespace` aliases a node in a global namespace tree. TypeScript has no such tree — the only thing to alias is a module specifier, and `import * as ns` is a real runtime binding, not a compile-time shorthand. | file |
| ◻ | Convert Extension Method to Plain Static | `ts/refactors/unpatch-prototype` | The nearest TS construct is a prototype patch plus a declaration-merged interface. This converts it back to a plain function, rewriting `xs.last()` into `last(xs)` and deleting both halves of the patch. | symbol |

### No TypeScript meaning

Ten entries have no analogue, and the reason is usually a fact about TypeScript worth stating.

| ReSharper | Why not |
| --- | --- |
| Make Partial | A class declaration has exactly one body; a second `class X` in scope is `TS2300`. TypeScript does merge declarations — for interfaces, enums, and `namespace` blocks — but it merges declaration *spaces*, never implementations, because a class body emits a constructor function and a prototype that cannot be assembled from two sources. |
| Convert static to extension method | There is no syntax for attaching a function to a type it doesn't declare. The `this` parameter (`function f(this: Foo, …)`) only *types* the receiver of a function already reachable through a property; it never makes `foo.f(x)` resolve. |
| Convert to Global Using | Inside a module a name is either explicitly imported or it is a global — and globals aren't module bindings at all, but ambient assertions about `globalThis`, with no module to resolve to and nothing emitted. |
| Introduce using enum | No declaration form opens a namespace into lexical scope. An enum member is a property of a runtime object and a member of a type namespace, and no syntax brings either into scope unqualified. |
| Move Resource · Inline Resource | `.resx` is a compilation input: MSBuild generates a strongly-typed class from it, so `Resources.Greeting` is a symbol the compiler resolves. Nothing in the TypeScript build plays that role — an i18n catalog is runtime data reached by string key, so following one is string matching, which [principle 1](docs/plan.md#guiding-principles) excludes from this repo. |
| Extract XAML Resource · Inline XAML Resource · Extract XAML Style | A `ResourceDictionary` is resolved by walking a visual tree at runtime, and an unkeyed style attaches itself implicitly to every element of a type in scope. TypeScript resolves names exactly two ways, lexically or through a module specifier, both settled statically — there is no second resolution system to collapse into or lift out of. |
| Extract CSS Style | CSS files are not members of a `ts.Program`. Both of a session's views are structurally unable to see the documents this reads and writes, and no symbol table contains a CSS rule. |

---

## Shared machinery

The five above are small tools over one substantial foundation, built and tested before any of them:

| Path | Holds |
| --- | --- |
| `ts/project/service.ts` | A `ts.LanguageService` over the same parsed tsconfig the program uses. `ts.Program` has no reference index and no refactor surface, so `findReferences`, `getApplicableRefactors`, `getEditsForRefactor`, `getEditsForFileRename`, `organizeImports`, and the code fixes are all unreachable without it. `program()` is the service's program, so a symbol resolved through the checker and a reference found through the service belong to the same graph. Its host reads through an overlay: files an edit creates are real, files it deletes are absent rather than empty, and directories that exist only in the proposed edit resolve. |
| `ts/refactors/guard.ts` | `diagnosticsIntroducedBy`, lifted out of `rename`. Created files enter `rootNames` — without that, a created file with a hard type error compiled green, the guard reporting clean on code it never saw. |
| `core/tool/types.ts`, `core/edits/apply.ts` | `WorkspaceEdit` grows file operations — create, rename, delete. `changes` keys name paths in the post-`fileOps` tree; renames run before content and deletions last, because a rename after text edits resolves every path key to a file that no longer exists. A case-only rename goes through a temp path. |
| `ts/refactors/text-changes.ts` | `ts.FileTextChanges[]` → `WorkspaceEdit`. The compiler speaks offset spans; the contract speaks line/character. |
| `ts/refactors/refactor-action.ts` | The safe wrapper around TypeScript's refactor engine, which throws rather than returning `undefined` for an inapplicable target, and whose own `notApplicableReason` strings are better refusal messages than anything we'd write. Asks whether a refactoring applies *before* asking for its edits, passes `triggerReason: 'invoked'` (whole refactor families are gated on it), and spreads TypeScript's default format settings rather than listing them — a key left out reads as `false`, which is how `a*b` gets emitted. |
| `ts/refactors/references.ts` | The reference classifier — declaration, read, write, import binding, direct call, escape — by parent node, never by `ReferenceEntry.isWriteAccess`, which reports `true` for a declaration, for an import specifier, and for `const { count } = c`, a destructuring *read*. |
| `ts/ast/targets.ts` | Symbol and position targeting, lifted out of `rename`: one addressing convention and one good ambiguity error for every symbol-addressed tool. |
| `ts/ast/hierarchy.ts` | The override closure — who else implements or overrides this member — which `ts.Program` does not index in reverse. Heritage symbols are resolved through `getAliasedSymbol`, or every cross-file `extends` reads as un-analyzable and a genuine override looks standalone. |
| `ts/ast/structural.ts` | Node identity in two forms: `shapeKey` excludes names and literals, `tokenKey` keeps them. Neither is derivable from the other, and using the wrong one produces a confidently wrong refactoring. |
| `ts/refactors/output.ts`, `ts/refactors/testing.ts` | The shared result envelope, and the copy-a-fixture-and-let-the-test-destroy-it helper every apply-mode test needs. |

## The next five

Ordered after probing what TypeScript's engine actually does for each candidate, which moved two of them and inverted one. All five have shipped; what follows is the record of why they were sequenced this way, and [round three](#deliberately-left-for-later) is next.

**The cost model, measured.** TypeScript 5.9.3 registers 15 refactors and 24 action kinds. Only 8 entries in the index above get any engine help at all; `change-signature`, the entire member-move family, and every inline are wholly our own code. That negative space, not the ReSharper naming, is what the ordering should follow.

| # | Tool | Index entries it retires | Engine help |
| --- | --- | --- | --- |
| ✅ | `ts/refactors/extract` | Extract Method, Introduce Variable, Introduce Field | `Extract Symbol` offers all three as *scopes* on one range |
| ✅ | `ts/refactors/change-signature` (options-object form) | Transform Parameters, and the beachhead of Change Signature | `Convert parameters to destructured object` |
| ✅ | `ts/refactors/extract-type` | Introduce type alias, Convert Anonymous to Named Type, Introduce typedef | `Extract type` |
| ✅ | `ts/refactors/inline-function` | Inline Method — and makes Inline Variable, Inline Field and Inline type alias shippable rather than hazardous | none usable |
| ✅ | `ts/refactors/module-form` | Introduce Namespace Alias, partly | `Convert export`, `Convert import` |

**✅ `extract` went first because it builds the addressing.** `Extract Symbol` offers "extract to inner function", "to method in class", "to constant", and "to readonly field" as scopes on the same range, so one tool retires three index entries; it propagates `async` and captured generics correctly, and returns a `renameLocation` so a caller-supplied name is a deterministic post-edit. The tool enumerates the offered scopes rather than guessing an index — an unoffered index throws a raw `TypeError` instead of refusing. Addressing is `{file, select, within?}`, where `select` is the exact source text, located by enumerating parsed candidate ranges and keying them with `tokenKey`. `within` is **optional**: 429 anonymous function bodies in this repo sit inside no named function, so requiring it would make them unreachable. The locator must not be built on `ts.createScanner` over raw text — without parser context it mis-tokenizes template literals and regex-versus-division.

**✅ `change-signature`, options-object form only.** `Convert parameters to destructured object` rewrites call sites *in other files*, including namespace-qualified ones — the only engine-backed cross-file signature edit that exists. Two defects the tool must own: with any non-call reference it reports applicable and returns **zero edits with no reason**, and it deduplicates call sites by offset without an equality comparer, so two calls at the same byte offset in different files collapse to one. Near-identical sibling files make that fire on real projects. So: classify every reference, refuse anything that is not a direct call, and diff the sites the engine touched against the classifier's set rather than shipping a partial rewrite. The positional form — reorder, retype — stays out permanently; the guard cannot see it.

**✅ `extract-type`, on `selection.ts`.** The delegating half is nearly free. The half worth owning is project-wide dedupe of structurally identical inline type literals, which is a genuine cross-file edit no model can make, because the precondition is knowledge of every other file. Dedupe keys on `tokenKey`, never `shapeKey` — the latter excludes names and literals and would conflate `{host: string}` with `{port: number}`.

**✅ `inline-function`, carrying the rest of the inline family.** This is the correction to the previous plan, which called `inline-variable` cheap delegation. It is not. TypeScript's inline-variable parenthesizes on precedence rank with no operand-position test (`const d = a - b; return c - d` becomes `return c - a - b`), performs no scope-capture check at all, and performs no purity check (`const v = bump()` used three times becomes three calls). The guard reports **zero new diagnostics** for the first two. Shipping it as delegation would put three wrong-answer classes into a guard-blind hole, which is the disqualifier this document opens with. What makes the family shippable is a `substitution.ts` that parenthesizes on operand position, resolves every root identifier at each substitution site, and refuses an impure expression used more than once. Expect this tool to refuse often; that is the point, because the alternative is not the model waiting but the model inlining by hand and `tsc` saying nothing.

**✅ `module-form` was the cheapest remaining tool whose whole difficulty is finding files the caller never opened.** Default-to-named rewrites every importer's specifier; namespace-to-named rewrites the import clause and every qualified use. The guard is complete here — a missed importer is `TS2613` or `TS1192`. It also regression-tests a rule worth having: the engine's import conversion re-derives its own target and ignores the action name it was asked for, so a wrapper must verify the requested action is the one applicability listed.

### New machinery these need

- ~~`ts/refactors/selection.ts`~~ — **shipped** with `extract`. The candidate enumerator described above; `extract-type` consumes it next.
- ~~`ts/refactors/signatures.ts`~~ — **shipped** with `change-signature`. The escape/spread-call gate and the `getResolvedSignature` argument mapper, lifted out of `inline-parameter`; `introduce-parameter` and `rest-parameter` consume it next.
- **`ts/refactors/substitution.ts`** — precedence, capture, and purity. Consumed by `inline-function` and every later inline.
- **An envelope rule**: an empty edit from an action that reported applicable is never reported as success. It is the one failure class the guard is structurally blind to, because there is nothing to typecheck. Whether it is an error or a repair depends on the reason — `change-signature` found TypeScript declining over a JSDoc `{@link}`, which is no reason to refuse, so the tool writes the conversion itself. `tryRefactor` in `refactor-action.ts` is what lets a tool tell "applicable, yet produced nothing" apart from a genuine refusal.

### Round four — what is left

The member-move family is the largest coherent group remaining, and `move-member` has now built
most of what it needs: `extract-class`, `extract-superclass`, `extract-interface`,
`pull-members-up`, `push-members-down`, `move-instance-method`. Then the member-form group
(`member-form`, `encapsulate-field`, `make-static`, `make-non-static`), which is cheap and was cut
on value rather than cost — none of them changes a call site in a way the compiler misses.
`introduce-parameter` is now small, since `selection.ts` and `signatures.ts` both exist.
`invert-boolean` is the last high-value entry outside those groups.

### Deliberately left for later

- **`move-member` / `move-instance-method`** — the god-*class* analogue of the shipped god-*module* fix, and the strongest thing cut. Wholly our own code, and materially cheaper once `signatures.ts` exists.
- **`widen-type`** — the guard is a *complete* oracle for it, since "still typechecks" is literally what `diagnosticsIntroducedBy` computes. What defers it is candidate generation, not value.
- **`extract-class`, `extract-superclass`, `extract-interface`, `pull-members-up`, `push-members-down`** — same member-move engine; build `move-member` first and these become tractable.
- **`encapsulate-field`, `member-form`, `make-static`** — cheap, and cut on *value*, not cost. None changes a call site in a way the compiler misses, so a model plus `tsc` already does them. Cheapness was never the criterion here.
- **`introduce-parameter`** — the composition of `extract`'s selection module (now shipped) and `change-signature`'s argument mapper. Cheap once the latter lands.
