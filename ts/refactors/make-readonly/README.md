# ts/refactors/make-readonly

Adds `readonly` to a class property that nothing writes outside its initializer and the declaring class's constructor. **The in-memory typecheck is a complete oracle for this refactoring rather than a backstop:** adding `readonly` to a property that is written produces exactly TS2540 — "Cannot assign to 'x' because it is a read-only property" — located at the offending write. So even a wrong reference analysis cannot ship a wrong edit; the worst case is a refusal carrying a precise location. Everything below the guard exists to explain the refusal in the caller's terms before the compiler proves it, not to be trusted instead of it.

ReSharper spells this "make auto-properties get-only". TypeScript has no auto-properties: there is one member kind, the property declaration, with `readonly`, `private`, `static` and `#name` as modifiers on it — so adding the modifier is the honest translation, and the parameter-property spelling (`constructor(private count: number)`) is the same declaration written in the constructor's parameter list and is handled identically.

**Dry-run by default.** Without `apply: true` the tool returns the `WorkspaceEdit` and touches nothing.

**Writes refuse the edit, and are listed.** Each blocking write is reported in `writes` with its file, zero-based position, and reference kind (`write`, `compound-write`, `destructure-write`). The permitted set mirrors the compiler's own rule exactly: `this.x = …` written directly in the constructor of the class that declares `x`. An assignment in a method, in a nested function inside the constructor, in a static block, in a subclass constructor, or through any receiver other than `this` is a write the modifier would break — TypeScript rejects all of these, and so does this tool.

**References are classified by parent node, never by `isWriteAccess`.** `ReferenceEntry.isWriteAccess` reports true for the declaration itself, for an import binding, and for `const { count } = c` — a destructuring *read*. A tool that refuses on it declines code it could safely transform. Classification here comes from the shared reference classifier, so `const { count } = c` in another file applies cleanly.

**A property with no type annotation gains one.** `count = 0` becomes `readonly count: number = 0`, not `readonly count = 0`: without the annotation a readonly property takes the literal type of its initializer (`0`), and a constructor assignment that compiles today fails with TS2322. The annotation is the widened type the property already has, so the public type is unchanged. The type is printed by the checker; a type whose name is not in scope at the declaration would fail the compile guard rather than being written.

**Compile guard.** Before writing, the project is typechecked in memory with the edit applied. Any introduced diagnostic is returned in `newDiagnostics` and the edit is refused — even with `apply: true`. When the refusal is about assignment, `newDiagnostics` and `writes` describe the same positions.

**`warnings` always says what `readonly` is not.** It is erased at compile time, so the emitted JavaScript has no such attribute and a JavaScript caller, `Object.assign`, or an `as any` cast still writes the property. Assignability ignores it, so passing the object where a mutable property is expected typechecks and writes through that alias are never reported. And it does not freeze the value: `readonly items: string[]` still permits `items.push(…)`. When the property holds an array, tuple, `Set` or `Map`, a fourth warning names the type and lists the in-place mutations already in the code.

## Input

| Option | Meaning |
| --- | --- |
| `symbol` | Property name to target; `#field` matches with or without the `#` |
| `class` | Declaring class name, when the same property name appears on several classes |
| `file`, `line`, `character` | Target an exact position (zero-based); `file` alone also narrows `symbol` |
| `apply` | Write to disk (default `false`) |

## Output

`{ applied, edit, filesChanged, newDiagnostics, warnings, writes }` — `edit` is an LSP-compatible `WorkspaceEdit` keyed by absolute file path, and `writes` is empty unless assignment is what refused the edit.

```sh
static-x ts/refactors/make-readonly --project path/to/project \
  --input '{"symbol": "limit", "class": "Counter", "apply": true}'
```

([Install instructions](../../../README.md#install).)
