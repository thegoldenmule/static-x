# Refactoring roadmap

[ReSharper's refactoring index](https://www.jetbrains.com/help/resharper/Refactorings__Index.html) is the most complete catalogue of code transformations any tool ships — 61 named refactorings, accumulated over twenty years of watching people rewrite C#. This document translates every one of them into TypeScript and into this repo's tool contract, so the set of refactorings static-x should own is a decision already made rather than one taken a tool at a time.

The 61 entries collapse to **TypeScript tools of which 28 are shipped, covering 34 index entries** — see the ✅ rows below. **10 have no TypeScript meaning at all**; a further **13 have a meaning and will still not be built**, either because modern TypeScript contains no instances of the construct or because the entry's stated justification did not survive being measured. Saying precisely why, in all three cases, is part of the translation.

The index is now closed. Nothing in it is waiting to be built, and the last round's work was retiring rows with evidence rather than adding tools.

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

**Status legend.** ✅ shipped · ✖ retired, with the reason recorded · ◻ᵗ conditional, with a written trigger · ✅ ✖ partly shipped, the rest permanently out.

There is no ◻ any more. Every entry now carries a disposition, which is what this document set out to produce: not that everything is built, but that nothing is waiting on a decision no one has taken.

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
| ✅ | Move Instance Method | `ts/refactors/move-instance-method` | Feature-envy surgery: moves a method onto the class of one of its parameters, flipping the receiver so `a.m(b, c)` becomes `b.m(a, c)`. Ports unchanged — TS classes carry state and prototype methods exactly as C# types do. | symbol |
| ◻ᵗ | Copy type | `ts/refactors/copy-type` | Duplicates a class, interface, alias, or enum into another file under a new name, rewriting self-references and adding the imports the copy needs. **Conditional, with a written trigger.** Demand is 12 hand-made copies in 1,729 declarations, of which one would have come out differently. Its import writing needs `dependencyImports`/`importEdits`, private to `move-member` — and `imports.ts` exists because *five* tools converged independently, not because one might. Build it when a second consumer forces that lift, at which point it is a few hundred lines on top. Do not lift speculatively. | symbol |

### Extract

| Status | ReSharper | Tool | In TypeScript | Addr. |
| --- | --- | --- | --- | --- |
| ✅ | Extract Method | `ts/refactors/extract` | Lifts a statement range or expression into a new function, computing parameters and return value from data flow through the selection. Async-ness, captured generics, and `this` usage propagate into the signature. Addressed by the code itself, not by offsets. | select |
| ✅ | Introduce Variable | `ts/refactors/extract` | Lifts an expression into a `const` in an enclosing scope — a *scope* of the same operation as Extract Method rather than a separate refactoring, which is why one tool covers both. | select |
| ✅ | Introduce type alias | `ts/refactors/extract-type` | Lifts a type expression into a named `type X = …`. Shipped by TypeScript itself as `refactor.extract.type`. | range |
| ✅ | Convert Anonymous to Named Type | `ts/refactors/extract-type` | C# anonymous types are *values*; the TypeScript analogue is the anonymous *type*. The half worth building beyond TypeScript's own action is `dedupe` — replacing every structurally identical inline occurrence project-wide. | range |
| ✅ | Introduce Field | `ts/refactors/extract` | Hoists an expression into a class property, offered as the "readonly field" scope. TypeScript has no field/property distinction — one member kind with `readonly`, `private`, and `#name` as modifiers — so this is "introduce class property" plus a placement decision C# doesn't face. | select |
| ✅ | Introduce Parameter | `ts/refactors/introduce-parameter` | Turns an expression inside a function into a new parameter, passing the original expression at every call site. Structural typing makes the function's *type*, not just its declaration, part of the blast radius. | range |
| ✅ | Extract Interface | `ts/refactors/extract-interface` | Generates an interface from a class's public members and adds `implements`. Structurally, that clause is a documented assertion rather than a requirement — consumers already accept the shape — so the half that buys anything is rewriting use sites from `C` to `I`. | symbol |
| ✅ | Extract Superclass | `ts/refactors/extract-superclass` | Pulls members into a new base class. The cheapest member-move in the family: inheritance preserves every call site, so there is no project-wide reference rewrite at all. | symbol |
| ✅ | Extract Class | `ts/refactors/extract-class` | The god-class split — members into a new class held by a private field, `this.m()` rewritten to `this.helper.m()`, with delegating stubs or a project-wide call-site rewrite. | symbol |

### Inline

| Status | ReSharper | Tool | In TypeScript | Addr. |
| --- | --- | --- | --- | --- |
| ✅ | Inline Parameter | `ts/refactors/inline-parameter` | When every call site passes the same value, drops the parameter from the signature and every call and introduces the value in the body. Also covers the TS shape where a defaulted parameter is never overridden. | symbol |
| ✅ | Inline Variable | `ts/refactors/inline-variable` | Replaces every read of a `const` with its initializer. The one entry TypeScript already implements outright, as `refactor.inline.variable`. | symbol |
| ✅ | Inline Method | `ts/refactors/inline-function` | Substitutes a function's body at its call sites and deletes it. Applies to all three TS callable forms; needs a precedence-aware expression printer the repo doesn't have yet, and re-evaluates side effects when an impure argument appears twice. | symbol |
| ✅ | Inline type alias | `ts/refactors/inline-type-alias` | Substitutes an alias's right-hand side at every use — `type Id = string \| number` used as `Id[]` becomes `(string \| number)[]`. C# inlines a `using X = …` directive; TS aliases are generic, conditional, and mapped, so the TS form does strictly more. | symbol |
| ✅ | Inline Field | `ts/refactors/inline-field` | Replaces reads of a never-reassigned class property with its initializer. Splits from the local-variable case because a field read has a *receiver*: `load().size` inlined drops the call, and an initializer reading `this` inlined at `other.size` reads the wrong object. Both compile. | symbol |

### Signature

| Status | ReSharper | Tool | In TypeScript | Addr. |
| --- | --- | --- | --- | --- |
| ✅ ✖ | Change Signature | `ts/refactors/change-signature` | **Options-object form shipped; positional form permanently out.** Converting parameters to a named object updates every call site across files, overload lists and overrides. Reordering or retyping positional parameters does not ship and will not: a reordered pair of compatible type compiles green and misbehaves, which is the one failure the guard structurally cannot see. ◻ was the wrong marker for a decision already taken. | symbol |
| ✅ | Transform Parameters | `ts/refactors/change-signature` | TypeScript has no `ref`/`out`, so the C# headline feature has no counterpart — you return a tuple or an object instead. What survives is the general parameter-list edit, plus a TS-native flavor: collapsing a long positional list into a destructured options object and back. | symbol |
| ✅ | Invert Boolean | `ts/refactors/invert-boolean` | Negates a boolean's returns and assignments and every read of it, optionally renaming. Sound only when the checker says the type is exactly `boolean`: truthiness coercion means `!x` is not an inversion for anything wider. | symbol |

### Members and hierarchy

| Status | ReSharper | Tool | In TypeScript | Addr. |
| --- | --- | --- | --- | --- |
| ✅ | Make auto-properties get-only | `ts/refactors/make-readonly` | TypeScript has no auto-properties, so the equivalent is `readonly` on a property nothing writes outside its initializer or constructor. The precondition is a project-wide write query — which is the whole value. | symbol |
| ✅ | Encapsulate Field | `ts/refactors/member-form` (`to: "accessor"`) | A public property becomes a private backing field plus a `get`/`set` pair — `readonly` yields a getter and no setter, and a constructor assignment is re-pointed at the backing field. Shipped under another name, so this row was never a build. The reasoning that once cut it was wrong: no call site changes, but the *value moves off the instance onto the prototype*, so `Object.keys` goes `['x']` to `['_x']`, `Object.hasOwn(o, 'x')` goes true to false, and object spread and `JSON.stringify` change shape. Nothing in the type system records that, which is why the tool warns. | symbol |
| ✅ | Convert Property to Auto-Property | `ts/refactors/member-form` | Collapses a `get`/`set` pair that only reads and writes one backing field into a plain property. A getter with no setter becomes `readonly`. | symbol |
| ✅ | Convert Method to Property | `ts/refactors/member-form` | A zero-argument `getFoo(): T` becomes `get foo(): T` — or a `readonly` field when the body is constant — rewriting every `x.getFoo()` into `x.foo`. | symbol |
| ✅ | Convert property to method(s) | `ts/refactors/member-form` | The reverse: reads `o.x` become `o.getX()`, writes `o.x = v` become `o.setX(v)`. | symbol |
| ✅ | Make Method/Property Static | `ts/refactors/static-form` | Adds `static` to a member that never touches instance state and rewrites `instance.m()` to `Class.m()`, importing the class where needed. A `this`-free method is the strongest signal a member doesn't belong to the instance. | symbol |
| ✅ | Make Method Non-Static | `ts/refactors/static-form` | Drops `static` and promotes a parameter to the receiver. TypeScript adds a wrinkle C# lacks — the explicit `this` parameter — though the idiomatic TS move is usually the opposite direction. | symbol |
| ✅ | Pull Members Up | `ts/refactors/pull-members-up` | Moves members into a base class, or pulls up only the signature when the target is an interface, since TS interfaces hold no implementations. | symbol |
| ✅ | Push Members Down | `ts/refactors/push-members-down` | The mirror. The subclass set isn't knowable from the base: `ts.Program` has no reverse-inheritance index, so the tool must scan heritage clauses project-wide and resolve each `extends` through the checker. | symbol |
| ✅ | Replace Constructor with Factory Method | `ts/refactors/constructor-to-factory` | Introduces a static factory, rewrites every `new Class(…)`, and closes the constructor — `protected` when the class has subclasses, since `private` breaks `super(…)`. The TS motivation is stronger than C#'s: constructors cannot be `async`, so factories are how you build objects that need to await. Accepts reference kinds by allowlist, because `const { C } = await import(…)` puts a `new` where no reference search can see it. | symbol |
| ✅ | Use Base Type Where Possible | `ts/refactors/widen-type` | Replaces an annotation with the least specific type that still typechecks everywhere. Structural typing makes the TS version strictly more powerful: the candidate isn't limited to declared ancestors — any structural supertype qualifies, including one synthesized from exactly the members the code touches. | symbol |

### Declaration form

| Status | ReSharper | Tool | In TypeScript | Addr. |
| --- | --- | --- | --- | --- |
| ✅ | Convert to scoped enum | `ts/refactors/enum-to-const-object` | TS enum members are already qualified, so the transferable half is the strictness: a numeric `enum` becomes a string enum, or an `as const` object plus a union type — losing the reverse mapping, the numeric assignability, and the runtime object. | symbol |
| ✅ | Introduce Namespace Alias | `ts/refactors/module-form` | C#'s `using X = Some.Long.Namespace` aliases a node in a global namespace tree. TypeScript has no such tree — the only thing to alias is a module specifier, and `import * as ns` is a real runtime binding, not a compile-time shorthand. | file |

### No TypeScript meaning

Ten entries have no analogue, and the reason is usually a fact about TypeScript worth stating. Two further sections follow, for entries that *do* have an analogue and still will not be built — the distinction matters, because these three reasons are not the same reason and a future entry will need all three.

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

### Real construct, no population

These have a genuine TypeScript meaning. They have no instances. Measured across ~1,050 first-party source files in four real projects (`powerhouse/packages/reactor`, `reactor-api`, `reactor-browser`, `sermon-search`), the constructs they act on number **zero** — and the zero is the finding, because a tool with no targets is not worth building however well it would work. Each was probed before it was cut; the evidence is recorded so a revisit starts from it rather than from the idea's appeal.

| ReSharper | Why not |
| --- | --- |
| Convert Abstract Class to Interface | 2 abstract classes in 1,050 files, neither convertible; 6 in the whole monorepo, 1 convertible — and its hand-written `IStorage` already sits directly beneath it. The structural argument outlives the count: `protected` on a type member is `TS1070`, so the only convertible shape is all-public, and an all-public abstract class is *already* structurally identical to the interface it would become. Dropping a `private` or `protected` member does flip overload resolution and conditional types with no diagnostic — but only for shapes that cannot be converted at all. |
| Convert Interface to Abstract Class | The output is an interface plus dead runtime code until someone writes the bodies the tool cannot invent. `extract-superclass` and `pull-members-up` are that path, and the latter already writes signature-only members when the destination is an interface. |
| Convert Indexer to Method · Convert Method to Indexer | 13 index signatures in 951 files: 4 are generic constraints with no receiver, 7 are wire/JSON payloads whose plain-object shape *is* the contract, 0 sit on a class, and 9 have no accesses to rewrite. An index signature has no body, so converting one does not move an implementation — it invents one. `JSON.parse(json) as Bag` then compiles clean and throws `b.get is not a function`. |
| Convert to Non-Global Using | 0 non-ambient `namespace` declarations anywhere. All 6 `declare global` blocks augment genuinely global runtime objects — `Window`, `WindowEventMap`, React's act flag, the YouTube IFrame API — which have no module to import from. Whether a binding is host-injected or module-exported is a runtime fact the checker cannot see. |
| Convert Extension Method to Plain Static | 0 prototype patches and 0 built-in interface augmentations in 1,062 files; 6 in the entire monorepo, all jsdom `vi.fn()` stubs with no declaration merge and no call sites. Worth recording what the tool would have prevented: unpatching changes `JSON.stringify` of the patched object from `{"name":"Error","message":"boom"}` to `{}`. |
| Inline Class | 0 of 190 classes satisfy the entry's own preconditions. TypeScript's single-consumer collaborator is an *injected interface implementation* — which is precisely the population the tool must refuse by definition, since the consumer depends on the interface rather than the class. |
| Introduce typedef · Inline typedef | 0 `.js` files in any `ts.Program` across 13 tsconfigs, `checkJs` in none of them, `@typedef` 0 in the corpora. And the guard would be inert here even if there were: `isSourceFileJS` gates the refactoring on file extension while `checkJs` gates diagnostics, so in the only JS configuration these projects contain, `diagnosticsIntroducedBy` compiles nothing and would bless anything. |

### Real population, no motivated target

Instances exist. Every one of them is correct as written, or the entry's stated justification does not survive being measured. These are the entries where probing changed the answer, which is the whole reason this document probes.

| ReSharper | Why not |
| --- | --- |
| Move to Resource (hoist a literal to a shared `const`) | **The stated justification is false, in both directions.** The index claimed `const MSG = 'ok'` keeps the type `'ok'` while the same literal in an object property widens to `string`, silently breaking narrowing. Measured: `{ kind: 'ok' }` and `{ kind: MSG }` both infer `{ kind: string }`, identically. Nothing widens that was not already wide. What remains is dedupe keyed on a string's *value*, which is grep, and [principle 1](docs/plan.md#guiding-principles) excludes it. 510 repeated-literal groups reduce to roughly 8 a reviewer would accept, and 42 of the best candidates are `typeof` operands the tool would have to refuse. |
| Introduce Variable for Substring | **The premise fails the same way.** TypeScript infers template literal types straight through `const` placeholders: `const verb = 'GE'; const m = \`${verb}T\`` has type `"GET"`, and passing it where `'GET'` is required reports nothing. So the conversion this entry describes loses no type information. 26 real targets in 943 files, all single-file and single-literal — no cross-file knowledge, and `tsc` is a complete oracle for what is left. |
| Add/Remove params modifier | Its TypeScript-specific justification — rest parameters "may be tuples with labeled and optional elements" — measures **0 tuple-typed and 0 non-last rest parameters in 13,619 callables**. Of 18 syntactic targets, 12 are test helpers and 0 are motivated production changes. |
| Move Type to Outer Scope | Two halves, both empty. All 16 nested-in-`namespace` declarations are `declare global`/`declare module` augmentations, which lifting *destroys* — they are anti-targets, not targets. Of 24 function-body declarations, 21 capture nothing at all, making the operation a pure text move where the typecheck sees every way it can fail. |


## Shared machinery

The five above are small tools over one substantial foundation, built and tested before any of them:

| Path | Holds |
| --- | --- |
| `ts/project/service.ts` | A `ts.LanguageService` over the same parsed tsconfig the program uses. `ts.Program` has no reference index and no refactor surface, so `findReferences`, `getApplicableRefactors`, `getEditsForRefactor`, `getEditsForFileRename`, `organizeImports`, and the code fixes are all unreachable without it. `program()` is the service's program, so a symbol resolved through the checker and a reference found through the service belong to the same graph. Its host reads through an overlay: files an edit creates are real, files it deletes are absent rather than empty, and directories that exist only in the proposed edit resolve. |
| `ts/refactors/guard.ts` | `diagnosticsIntroducedBy`, lifted out of `rename`. Created files enter `rootNames` — without that, a created file with a hard type error compiled green, the guard reporting clean on code it never saw. |
| `core/tool/types.ts`, `core/edits/apply.ts` | `WorkspaceEdit` grows file operations — create, rename, delete. `changes` keys name paths in the post-`fileOps` tree; renames run before content and deletions last, because a rename after text edits resolves every path key to a file that no longer exists. A case-only rename goes through a temp path. |
| `ts/refactors/imports.ts` | Taking bindings out of files that no longer name a symbol, and writing the ones the code now needs. Not tidying: a specifier left naming something gone is `TS2305` and a missing one is `TS2304`, both of which refuse the whole edit at the guard. Five tools arrived at the same cases independently before this existed. |
| `ts/refactors/text-changes.ts` | `ts.FileTextChanges[]` → `WorkspaceEdit`. The compiler speaks offset spans; the contract speaks line/character. |
| `ts/refactors/refactor-action.ts` | The safe wrapper around TypeScript's refactor engine, which throws rather than returning `undefined` for an inapplicable target, and whose own `notApplicableReason` strings are better refusal messages than anything we'd write. Asks whether a refactoring applies *before* asking for its edits, passes `triggerReason: 'invoked'` (whole refactor families are gated on it), and spreads TypeScript's default format settings rather than listing them — a key left out reads as `false`, which is how `a*b` gets emitted. |
| `ts/refactors/references.ts` | The reference classifier — declaration, read, write, import binding, direct call, escape — by parent node, never by `ReferenceEntry.isWriteAccess`, which reports `true` for a declaration, for an import specifier, and for `const { count } = c`, a destructuring *read*. |
| `ts/ast/targets.ts` | Symbol and position targeting, lifted out of `rename`: one addressing convention and one good ambiguity error for every symbol-addressed tool. |
| `ts/ast/hierarchy.ts` | The override closure — who else implements or overrides this member — which `ts.Program` does not index in reverse. Heritage symbols are resolved through `getAliasedSymbol`, or every cross-file `extends` reads as un-analyzable and a genuine override looks standalone. A container is a class, an interface, *or a type alias for an object type*: `implements Shape` where `Shape` is `type Shape = {…}` was reported unresolvable — the same answer given for a mixin — which mislabelled 54 of 275 class properties across five real packages. |
| `ts/refactors/stability.ts` | Whether an expression still means what it meant once it is moved to where it is read: duplicated calls, duplicated allocations, a name reassigned in between, a `this` that rebinds. Every one of these compiles, so none is a guard's job. Written against `inline-variable` and generalized when `inline-field` needed all nine predicates unchanged. |
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

### Round four, and what closed the index

Round four built the member-move family — `move-member`, `move-instance-method`,
`extract-class`, `extract-superclass`, `extract-interface`, `pull-members-up`,
`push-members-down` — then the member-form group, `introduce-parameter` and
`invert-boolean`. Round five added `inline-field` and `constructor-to-factory`, and then
stopped, because the round after it found nothing left to build.

**Every remaining entry was probed rather than estimated, and none of them survived.** The
measurements are in the two retirement sections above. Three of them are worth naming as
reasons in their own right, because they are not the same reason and a future entry will
need all three:

1. **Real construct, no population.** It means something in TypeScript; modern TypeScript
   contains no instances. Prototype patches, non-ambient `namespace` blocks, JSDoc
   `@typedef` — 0 of each across ~1,050 first-party files.
2. **Real population, no motivated target.** Instances exist and every one is correct as
   written, or the entry's justification does not survive measurement. Both string-literal
   entries died this way, and both of their premises turned out to be *false*: neither
   hoisting a literal nor converting one to a template loses any type information.
3. **Already shipped under another name.** Encapsulate Field is `member-form` with
   `to: "accessor"`.

The lesson worth carrying is about the instrument, not the entries. A `targetCount` is
**motivated targets surviving the tool's own refusals**, never syntactic candidates —
`inline-field` shipped correct and accepted 0 of 275 real fields, and every later
assessment that counted syntax instead of motivation ranked itself roughly backwards.
Count what a tool would actually accept, before building it.

### What is not done: the territory

The index is closed. The *territory* is not, and the difference is the point.

ReSharper's catalogue is C#'s map of refactoring, drawn before TypeScript existed. It has
no entry for the failures that are hardest to see here, and this repo has already started
building past it: `ts/async/floating-promises`, `ts/types/loopholes`, `ts/graph/dead-exports`,
`ts/comments/*`. Those have no ReSharper counterpart at all, and they fit this document's
own criterion better than most of the rows above — a floating promise, an `any` laundered
through a cast, an export nothing imports are all invisible to a typecheck by construction.

Two live defects found in the *shipped* `extract` tool during the same round make the case
plainly: extracting a `'use client'` directive, or the specifier of `import('./m.js')`,
both produced clean compiles and wrong code. Neither is an index entry. Both were worth
more than any row left on the list.

So the next roadmap should not be a translation. It should start from the corpora and ask
what compiles clean and is wrong.
