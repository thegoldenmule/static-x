import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { memberHierarchy } from '../../ast/hierarchy.js';
import {
  declarationAt,
  findDeclarations,
  resolveTarget,
  SYMBOL_TARGET_PROPERTIES,
  type ResolvedTarget,
} from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences, isUse, isWrite, type ClassifiedReference } from '../references.js';
import { userPreferences } from '../refactor-action.js';
import {
  argumentIndexOf,
  assertOnlyCalls,
  locationOf,
  resolveCall,
  surveyCallSites,
} from '../signatures.js';
import { mayHaveEffects, needsParentheses, unalias } from '../substitution.js';

/**
 * Whether a class member takes a receiver — ReSharper's *Make
 * Method/Property Static* and *Make Method Non-Static*, which are one
 * operation run in two directions.
 *
 * **`to: 'static'`** adds `static` and rewrites `instance.m(…)` to
 * `Class.m(…)` everywhere, importing the class where a call site does
 * not already name it. The precondition is that the member never
 * touches the receiver, and a `this`-free body is the strongest
 * available evidence of that: the walk looks for `this` and `super` and
 * stops at nested non-arrow functions, which bind their own `this` and
 * therefore say nothing about this member's.
 *
 * **`to: 'instance'`** drops `static` and promotes a parameter to the
 * receiver, so `C.m(a, b)` becomes `a.m(b)` and the parameter's name
 * becomes `this` in the body. `receiver` names the parameter.
 *
 * **Arguments are mapped through the resolved signature, never by
 * counting commas.** A `this` parameter is declared in the parameter
 * list and occupies no slot in the argument list, so
 * `static seal(this: void, vault: Vault, note: string)` has its
 * receiver at declaration index 1 and argument index 0 — deleting
 * argument 1 would delete the note. `inline-parameter` exists partly to
 * have proved that; `argumentIndexOf` over `getResolvedSignature` is
 * the answer both tools use.
 *
 * **What is refused, and why the guard would not have caught it.**
 * Dropping a receiver drops whatever evaluating it did:
 * `makeFormatter().trim(x)` becomes `Formatter.trim(x)`, which compiles
 * and no longer builds a formatter. Optional chaining is the same
 * failure wearing a `?.`: the guard it expressed disappears. A member
 * the hierarchy shares has more than one declaration and only one of
 * them would change. A member handed out as a value has its shape
 * checked by assignability rather than at a call (`assertOnlyCalls`).
 * And a static property is one slot for the whole program where an
 * instance property is one slot per instance, so a member written
 * anywhere, or whose initializer does anything, is refused rather than
 * quietly collapsed.
 *
 * The idiomatic TypeScript direction is usually `to: 'instance'`, and
 * more often still `to: 'instance'` followed by a move to module scope
 * — see `ts/refactors/move-member`, whose `toFile` does exactly that.
 * A module is already a namespace, which is the job static classes do
 * in C#.
 */

export interface StaticFormInput {
  /** Member to change, by name. */
  symbol?: string;
  /** Class the member is declared on, when the name is not unique. */
  class?: string;
  file?: string;
  line?: number;
  character?: number;
  /** Which form the member should end up in. */
  to: 'static' | 'instance';
  /** For `to: 'instance'`, the parameter that becomes the receiver. */
  receiver?: string;
  apply?: boolean;
}

export interface CallSitePosition {
  file: string;
  line: number;
  character: number;
}

export interface StaticFormOutput extends RefactorOutput {
  /** Every reference the edit re-points, in the pre-edit tree. */
  callSites: CallSitePosition[];
}

type Member = ts.MethodDeclaration | ts.PropertyDeclaration;

const SOURCE_TO_IMPORT_EXTENSION: Record<string, string> = { '.mts': '.mjs', '.cts': '.cjs' };

/**
 * The symbol a name ultimately denotes.
 *
 * Two indirections, and the second is invisible until it bites. An
 * imported binding's own flags are `Alias`, so it has to be unaliased —
 * that much `unalias` already knows. But `export class C` also puts a
 * *second* symbol in the file's locals, flagged `ExportValue` and
 * linked to the exported one, and that is the symbol
 * `getSymbolsInScope` reports for a site inside the class's own file.
 * Comparing it with the class symbol says they are unrelated, so a
 * same-file call site is reported as one where the class name "already
 * means something else" — measured on `this.pad(…)` inside `Formatter`.
 */
function denoted(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return checker.getExportSymbolOfSymbol(unalias(checker, symbol));
}

/** The class a resolved target declares a member on. */
function containerOf(declaration: ts.Node): ts.ClassLikeDeclaration | undefined {
  const parent = declaration.parent as ts.Node | undefined;
  return parent && ts.isClassLike(parent) ? parent : undefined;
}

/**
 * Resolve the member. `class` narrows before `resolveTarget` would
 * refuse: `render` on two classes is two symbols, and picking either
 * without being told is how a tool refactors the wrong one.
 */
function resolveMember(session: TsProjectSession, input: StaticFormInput): ResolvedTarget {
  if (input.symbol === undefined || input.class === undefined) return resolveTarget(session, input);
  const candidates = findDeclarations(session, input.symbol, input.file).filter((candidate) => {
    const container = candidate.declaration && containerOf(candidate.declaration);
    return container?.name?.text === input.class;
  });
  if (candidates.length === 0) {
    throw new Error(`No member named "${input.symbol}" is declared on class "${input.class}"`);
  }
  if (new Set(candidates.map((candidate) => candidate.file)).size > 1) {
    const locations = candidates
      .map((candidate) => `${candidate.file}:${candidate.position.line + 1}`)
      .join('\n  ');
    throw new Error(
      `"${input.class}.${input.symbol}" is declared in multiple files; disambiguate with ` +
        `file/line/character:\n  ${locations}`,
    );
  }
  return candidates[0]!;
}

/**
 * The first `this` or `super` that binds to the member's receiver.
 *
 * A nested `function`, method, accessor, constructor or class binds its
 * own `this`, so the walk stops there — a `this` inside one says
 * nothing about whether *this* member needs a receiver. An arrow does
 * not bind its own, so it is followed.
 */
function receiverUse(member: ts.Node): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
      found = node;
      return;
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassLike(node)
    ) {
      return;
    }
    node.forEachChild(visit);
  };
  member.forEachChild(visit);
  return found;
}

/** Whether `node` sits inside a function that binds its own `this`. */
function insideOwnThis(node: ts.Node, member: ts.Node): boolean {
  for (let current = node.parent as ts.Node | undefined; current && current !== member; current = current.parent) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isClassLike(current)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The property access a reference is the name of — the `fmt` of
 * `fmt.pad(…)`. A reference this cannot describe is one the rewrite
 * cannot re-point, which is a refusal rather than something to skip.
 */
function accessOf(node: ts.Node): ts.PropertyAccessExpression | undefined {
  const parent = node.parent as ts.Node | undefined;
  return parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === node
    ? parent
    : undefined;
}

/**
 * The span that deletes one element of a comma-separated list along
 * with the comma joining it to its neighbours. Deleting forward keeps
 * the next element's own leading layout; the last element has no next,
 * so the preceding comma is eaten instead.
 */
function removalRange(
  items: readonly ts.Node[],
  index: number,
  sourceFile: ts.SourceFile,
): { start: number; end: number } {
  const item = items[index]!;
  const next = items[index + 1];
  if (next) return { start: item.getStart(sourceFile), end: next.getStart(sourceFile) };
  const previous = items[index - 1];
  if (previous) return { start: previous.getEnd(), end: item.getEnd() };
  return { start: item.getStart(sourceFile), end: item.getEnd() };
}

/**
 * One replacement that removes several parameters at once.
 *
 * Two `removalRange` spans in the same list can overlap — removing
 * `this` takes the comma *after* it while removing a trailing parameter
 * takes the comma *before* it, and with two parameters those are the
 * same comma — and `applyTextEdits` rejects the pair rather than
 * silently producing nonsense. So the multi-removal case rewrites the
 * whole list from the parameters that survive.
 */
function parameterRemoval(
  parameters: readonly ts.ParameterDeclaration[],
  remove: readonly number[],
  sourceFile: ts.SourceFile,
): { start: number; end: number; newText: string } {
  if (remove.length === 1) {
    return { ...removalRange(parameters, remove[0]!, sourceFile), newText: '' };
  }
  const kept = parameters.filter((_, index) => !remove.includes(index));
  return {
    start: parameters[0]!.getStart(sourceFile),
    end: parameters[parameters.length - 1]!.getEnd(),
    newText: kept.map((parameter) => parameter.getText(sourceFile)).join(', '),
  };
}

/** A relative module specifier for `toFile`, as written from `fromFile`. */
function relativeSpecifier(fromFile: string, toFile: string, withExtension: boolean): string {
  const relative = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  const dotted = relative.startsWith('.') ? relative : `./${relative}`;
  const extension = path.extname(dotted);
  const stem = dotted.slice(0, dotted.length - extension.length);
  return withExtension ? stem + (SOURCE_TO_IMPORT_EXTENSION[extension] ?? '.js') : stem;
}

/** Module file an import declaration resolves to, if any. */
function resolvedModuleOf(
  session: TsProjectSession,
  declaration: ts.ImportDeclaration,
): string | undefined {
  if (!ts.isStringLiteral(declaration.moduleSpecifier)) return undefined;
  const resolved = ts.resolveModuleName(
    declaration.moduleSpecifier.text,
    declaration.getSourceFile().fileName,
    session.program().getCompilerOptions(),
    ts.sys,
  ).resolvedModule;
  return resolved ? path.resolve(resolved.resolvedFileName) : undefined;
}

/**
 * Edits that bind `name` from `from` in `sourceFile`.
 *
 * A file that already imports something from that module grows a name
 * rather than a statement, so a rewrite never leaves two import
 * declarations for one module behind.
 */
function importEdits(
  session: TsProjectSession,
  sourceFile: ts.SourceFile,
  name: string,
  from: string,
): TextEdit[] {
  const at = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset);
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);

  for (const declaration of imports) {
    const bindings = declaration.importClause?.namedBindings;
    if (
      bindings === undefined ||
      !ts.isNamedImports(bindings) ||
      declaration.importClause?.isTypeOnly === true ||
      bindings.elements.length === 0 ||
      resolvedModuleOf(session, declaration) !== from
    ) {
      continue;
    }
    const last = bindings.elements[bindings.elements.length - 1]!;
    return [{ range: { start: at(last.getEnd()), end: at(last.getEnd()) }, newText: `, ${name}` }];
  }

  const preferences = userPreferences(session);
  const quote = preferences.quotePreference === 'double' ? '"' : "'";
  const specifier = relativeSpecifier(
    path.resolve(sourceFile.fileName),
    from,
    preferences.importModuleSpecifierEnding === 'js',
  );
  const statement = `import { ${name} } from ${quote}${specifier}${quote};`;

  const lastImport = imports[imports.length - 1];
  if (lastImport) {
    const end = lastImport.getEnd();
    return [{ range: { start: at(end), end: at(end) }, newText: `\n${statement}` }];
  }
  const first = sourceFile.statements[0];
  const start = first ? first.getStart(sourceFile, true) : 0;
  return [{ range: { start: at(start), end: at(start) }, newText: `${statement}\n\n` }];
}

/** The whole line (or lines) a statement occupies, newline included. */
function lineSpanOf(node: ts.Node, sourceFile: ts.SourceFile): { start: number; end: number } {
  const text = sourceFile.getFullText();
  let start = node.getStart(sourceFile, true);
  while (start > 0 && text[start - 1] !== '\n') start--;
  let end = node.getEnd();
  while (end < text.length && text[end] !== '\n') end++;
  if (end < text.length) end++;
  return { start, end };
}

/**
 * An identifier that refers to something rather than naming it — the
 * set whose meaning the surrounding scope decides, and so the set that
 * decides whether an import is still needed.
 */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isImportClause(parent) && parent.name === node) return false;
  return true;
}

/**
 * Remove the class's import from a file the rewrite leaves with no
 * reference to it.
 *
 * `C.m(a, b)` becoming `a.m(b)` is the one edit here that can take the
 * last mention of a name out of a file, and a project with
 * `noUnusedLocals` reports the orphan as `TS6133` — a diagnostic the
 * guard attributes to this edit and refuses the whole refactoring over.
 */
function pruneImport(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  classSymbol: ts.Symbol,
  removed: ReadonlySet<ts.Node>,
): TextEdit[] {
  let live = false;
  const visit = (node: ts.Node): void => {
    if (live) return;
    if (ts.isIdentifier(node) && isReference(node) && !removed.has(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol !== undefined && denoted(checker, symbol) === classSymbol) live = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  if (live) return [];

  const at = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const orphan = bindings.elements.find((element) => {
      const symbol = checker.getSymbolAtLocation(element.name);
      return symbol !== undefined && denoted(checker, symbol) === classSymbol;
    });
    if (!orphan) continue;

    const survivors = bindings.elements.filter((element) => element !== orphan);
    if (survivors.length > 0) {
      // One replacement of the whole clause rather than one deletion:
      // two deletions in the same list overlap at the comma between.
      return [
        {
          range: { start: at(bindings.getStart(sourceFile)), end: at(bindings.getEnd()) },
          newText: `{ ${survivors.map((element) => element.getText(sourceFile)).join(', ')} }`,
        },
      ];
    }
    if (statement.importClause?.name) {
      return [
        {
          range: { start: at(statement.importClause.name.getEnd()), end: at(bindings.getEnd()) },
          newText: '',
        },
      ];
    }
    const span = lineSpanOf(statement, sourceFile);
    return [{ range: { start: at(span.start), end: at(span.end) }, newText: '' }];
  }
  return [];
}

/**
 * Whether the receiver argument has to be wrapped when it moves to the
 * left of a property access.
 *
 * Two authorities, because each catches what the other misses. The
 * factory's parenthesizer is the compiler's own rule for this exact
 * position — it is what knows that `new Foo` needs parentheses and
 * `new Foo()` does not — while `needsParentheses` is this repo's
 * conservative operand-position test, and it is the one that wraps an
 * object literal, which would otherwise open a block at the start of an
 * expression statement.
 */
function wrapReceiver(argument: ts.Expression, site: ts.Node): boolean {
  const access = ts.factory.createPropertyAccessExpression(argument, 'x');
  return (
    (ts.isParenthesizedExpression(access.expression) && !ts.isParenthesizedExpression(argument)) ||
    needsParentheses(argument, site)
  );
}

/** Where `static ` goes, and what exactly to insert there. */
function staticInsertion(
  member: Member,
  sourceFile: ts.SourceFile,
): { offset: number; text: string } {
  const modifiers = ts.getModifiers(member) ?? [];
  const accessibility = modifiers.filter(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.PublicKeyword ||
      modifier.kind === ts.SyntaxKind.PrivateKeyword ||
      modifier.kind === ts.SyntaxKind.ProtectedKeyword,
  );
  const last = accessibility[accessibility.length - 1];
  if (last) return { offset: last.getEnd(), text: ' static' };
  const first = modifiers[0];
  return { offset: (first ?? member.name).getStart(sourceFile), text: 'static ' };
}

/** The token the `static` keyword is deleted up to. */
function afterStatic(member: Member, keyword: ts.Modifier): ts.Node {
  const modifiers = ts.getModifiers(member) ?? [];
  const next = modifiers[modifiers.indexOf(keyword) + 1];
  if (next) return next;
  if (ts.isMethodDeclaration(member) && member.asteriskToken) return member.asteriskToken;
  return member.name;
}

export const staticForm: Tool<StaticFormInput, StaticFormOutput, TsProjectSession> = {
  name: 'ts/refactors/static-form',
  description:
    'Changes whether a class member takes a receiver, in either direction — ReSharper\'s Make ' +
    'Method/Property Static and Make Method Non-Static. to: "static" adds `static` to a member ' +
    'that never touches instance state and rewrites every `instance.m(...)` to `Class.m(...)`, ' +
    'importing the class where a call site does not already name it. to: "instance" drops ' +
    '`static` and promotes the parameter named by `receiver` to the receiver, so `C.m(a, b)` ' +
    'becomes `a.m(b)` at every call site and the parameter becomes `this` in the body; the ' +
    'argument to drop is found through the checker-resolved signature, so a `this` parameter ' +
    'or an omitted optional cannot shift it. Target the member by name (symbol), narrowed by ' +
    'class when the name is not unique, or by exact position. Refuses: any use of `this` or ' +
    '`super` in the body (a nested non-arrow function binds its own, so the walk stops there); ' +
    'a member handed out as a value, where its shape is checked by assignability; a call site ' +
    'whose receiver expression does something, since dropping it drops what it did; optional ' +
    'chaining, whose guard would disappear; a reference reached through a string key; a member ' +
    'the class hierarchy shares; accessors; a receiver parameter whose type is not the ' +
    'declaring class, or that a call site omits, or that the body reassigns; and, for a ' +
    'property, one that anything writes or whose initializer has effects, because a static ' +
    'property is one slot for the whole program. In TypeScript the usual direction is ' +
    'to: "instance" and then out to module scope (ts/refactors/move-member --toFile), since a ' +
    'module already provides the namespacing C# needs static classes for. Dry-run by default; ' +
    'apply: true writes to disk unless the typecheck reports newDiagnostics.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      symbol: { type: 'string', description: 'Member name to target' },
      class: {
        type: 'string',
        description: 'Class the member is declared on, when the name is not unique',
      },
      to: {
        type: 'string',
        enum: ['static', 'instance'],
        description: 'Which form the member should end up in',
      },
      receiver: {
        type: 'string',
        description: 'For to: "instance", the parameter that becomes the receiver',
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    required: ['to'],
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      callSites: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            line: { type: 'integer' },
            character: { type: 'integer' },
          },
          required: ['file', 'line', 'character'],
        },
      },
    },
    ['callSites'],
  ),

  async run(session, input) {
    if (input.to !== 'static' && input.to !== 'instance') {
      throw new Error('to must be "static" or "instance"');
    }

    const checker = session.checker();
    const target = resolveMember(session, input);
    const declaration = declarationAt(target);
    const sourceFile = target.sourceFile;
    const container = containerOf(declaration);

    if (!container) {
      throw new Error(
        `"${declaration.name?.getText(sourceFile) ?? input.symbol}" is not a class member. ` +
          '`static` is a class modifier; a module-level binding has no receiver to gain or lose.',
      );
    }
    const className = container.name?.text;
    const memberName = declaration.name?.getText(sourceFile) ?? '(unnamed)';
    const where = `${className ?? '(anonymous class)'}.${memberName}`;

    if (ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)) {
      throw new Error(
        `${where} is an accessor. A static accessor is reached as \`${className ?? 'C'}.${memberName}\` ` +
          'rather than through an instance, which is a different member and a different call ' +
          'shape at every site; convert the accessor to a method first (ts/refactors/member-form).',
      );
    }
    if (!ts.isMethodDeclaration(declaration) && !ts.isPropertyDeclaration(declaration)) {
      throw new Error(
        `${where} is a ${ts.SyntaxKind[declaration.kind]}; only a method or a property has a ` +
          'static and an instance form',
      );
    }
    const member: Member = declaration;
    if (className === undefined) {
      throw new Error(
        `${memberName} is declared on an anonymous class, which no call site can name`,
      );
    }
    if (!ts.isIdentifier(member.name)) {
      throw new Error(
        `${where} has a ${ts.isPrivateIdentifier(member.name) ? 'private' : 'computed'} name, ` +
          'which this rewrite cannot re-point',
      );
    }
    if (sourceFile.isDeclarationFile) {
      throw new Error(
        `${sourceFile.fileName} is a declaration file; it describes an implementation this ` +
          'project does not own',
      );
    }

    const modifierFlags = ts.getCombinedModifierFlags(member);
    const isStatic = (modifierFlags & ts.ModifierFlags.Static) !== 0;
    if (input.to === 'static' && isStatic) throw new Error(`${where} is already static`);
    if (input.to === 'instance' && !isStatic) {
      throw new Error(`${where} is already an instance member`);
    }
    if (modifierFlags & ts.ModifierFlags.Abstract || (ts.isMethodDeclaration(member) && !member.body)) {
      throw new Error(`${where} has no body, so it has no receiver to keep or drop`);
    }
    if ((ts.getDecorators(member) ?? []).length > 0) {
      throw new Error(
        `${where} is decorated, and a decorator on an instance member receives the prototype ` +
          'while one on a static receives the constructor. The decorator would run against a ' +
          'different object, which a typecheck does not see.',
      );
    }

    // A member the hierarchy shares has more than one declaration and
    // this edit changes one of them, leaving the others describing a
    // member that no longer exists in the form they say it does.
    const hierarchy = memberHierarchy(session, member);
    if (hierarchy.unresolved.length > 0) {
      throw new Error(
        `${className}'s hierarchy cannot be resolved (${hierarchy.unresolved.join(', ')}), so ` +
          'another declaration of this member could be invisible',
      );
    }
    if (hierarchy.supertypes.length + hierarchy.subtypes.length > 0) {
      const others = [...hierarchy.supertypes, ...hierarchy.subtypes]
        .map((other) => `${other.container} (${other.file}:${other.line + 1})`)
        .join(', ');
      throw new Error(
        `${where} is also declared by ${others}; changing one declaration of a shared member ` +
          'leaves the others in the other form',
      );
    }

    // In an instance member `this` is the instance; in a static it is
    // the constructor. Either way it means something else after the
    // change, and both spellings compile.
    const receiverInBody = receiverUse(member);
    if (receiverInBody) {
      const keyword = receiverInBody.kind === ts.SyntaxKind.SuperKeyword ? '`super`' : '`this`';
      throw new Error(
        `${where} reads ${keyword} at ${locationOf(sourceFile, receiverInBody.getStart(sourceFile))}. ` +
          (isStatic
            ? 'In a static that is the constructor, and it would become the instance.'
            : 'In an instance member that is the instance, and it would become the constructor.'),
      );
    }

    const twin = container.members.find(
      (other) =>
        other !== member &&
        other.name !== undefined &&
        ts.isIdentifier(other.name) &&
        other.name.text === memberName &&
        ((ts.getCombinedModifierFlags(other as ts.Declaration) & ts.ModifierFlags.Static) !== 0) ===
          (input.to === 'static'),
    );
    if (twin) {
      throw new Error(
        `${className} already declares ${input.to === 'static' ? 'a static' : 'an instance'} ` +
          `member named "${memberName}"`,
      );
    }

    const declared = container.name ? checker.getSymbolAtLocation(container.name) : undefined;
    if (!declared) throw new Error(`${className} has no symbol to resolve references against`);
    const containerSymbol = denoted(checker, declared);

    const changes = new Map<string, TextEdit[]>();
    const editIn = (file: ts.SourceFile, start: number, end: number, newText: string): void => {
      const key = path.resolve(file.fileName);
      changes.set(key, [
        ...(changes.get(key) ?? []),
        {
          range: {
            start: file.getLineAndCharacterOfPosition(start),
            end: file.getLineAndCharacterOfPosition(end),
          },
          newText,
        },
      ]);
    };
    const warnings: string[] = [];
    const callSites: CallSitePosition[] = [];

    if (input.to === 'static') {
      // A property is the case where the two forms are not two spellings
      // of one thing: an instance property is one slot per instance and
      // a static is one for the program, so anything that writes it —
      // or an initializer that does anything — makes the two programs
      // different in a way nothing typechecks.
      let uses: ClassifiedReference[];
      if (ts.isMethodDeclaration(member)) {
        const survey = surveyCallSites(session, target.file, target.offset, memberName);
        assertOnlyCalls(memberName, survey, `making "${memberName}" static`);
        uses = survey.uses;
      } else {
        uses = classifyReferences(session, target.file, target.offset).filter(isUse);
        const writes = uses.filter(isWrite);
        if (writes.length > 0) {
          throw new Error(
            `${where} is written at ${writes
              .map((write) => `${write.file}:${write.line + 1}:${write.character + 1}`)
              .join(', ')}. A static property is one slot shared by every instance, so those ` +
              'writes would stop being per-instance.',
          );
        }
        if (member.initializer && mayHaveEffects(member.initializer)) {
          throw new Error(
            `${where} is initialized with \`${member.initializer.getText(sourceFile)}\`, which is ` +
              'evaluated once per instance today and would be evaluated once for the whole ' +
              'program',
          );
        }
        warnings.push(
          `${where} becomes one slot shared by every instance of ${className}. Nothing writes it ` +
            'today, so the two programs agree; a future write would not be per-instance.',
        );
      }

      const unreachable: string[] = [];
      const effectful: string[] = [];
      const rewrites: { file: ts.SourceFile; access: ts.PropertyAccessExpression }[] = [];
      for (const use of uses) {
        const access = accessOf(use.node);
        const useFile = use.node.getSourceFile();
        if (!access) {
          unreachable.push(
            `${use.file}:${use.line + 1}:${use.character + 1} (${use.node.parent.getText(useFile).slice(0, 60)})`,
          );
          continue;
        }
        if (access.questionDotToken) {
          unreachable.push(
            `${use.file}:${use.line + 1}:${use.character + 1} (${access.getText(useFile)} — ` +
              'optional chaining, whose nullish guard would disappear)',
          );
          continue;
        }
        if (mayHaveEffects(access.expression)) {
          effectful.push(
            `${locationOf(useFile, access.getStart(useFile))}: ${access.expression.getText(useFile)}`,
          );
          continue;
        }
        // `mayHaveEffects` reads syntax, and a property read is syntax
        // that runs arbitrary code when the property is an accessor. So
        // a dropped receiver more complicated than a name is reported
        // rather than certified.
        if (
          !ts.isIdentifier(access.expression) &&
          access.expression.kind !== ts.SyntaxKind.ThisKeyword
        ) {
          warnings.push(
            `${locationOf(useFile, access.getStart(useFile))} drops the receiver ` +
              `\`${access.expression.getText(useFile)}\`. Nothing in it calls anything, but a ` +
              'property read there runs a getter if one is declared, and that is an effect no ' +
              'syntactic check sees.',
          );
        }
        rewrites.push({ file: useFile, access });
      }
      if (unreachable.length > 0) {
        throw new Error(
          `${where} is reached by references this rewrite cannot describe — through a string ` +
            `key, a destructuring, or an optional chain:\n  ${unreachable.join('\n  ')}`,
        );
      }
      if (effectful.length > 0) {
        throw new Error(
          `${where} is called on a receiver that does something, and \`${className}.${memberName}\` ` +
            `would not do it:\n  ${effectful.join('\n  ')}`,
        );
      }

      const needsImport = new Set<ts.SourceFile>();
      for (const { file, access } of rewrites) {
        const start = access.expression.getStart(file);
        const position = file.getLineAndCharacterOfPosition(start);
        callSites.push({ file: path.resolve(file.fileName), line: position.line, character: position.character });

        // The class has to be nameable here. A binding already pointing
        // at it wins whatever it is called locally, so an aliased import
        // keeps its alias rather than gaining a second name for one
        // class.
        let localName: string | undefined;
        let claimed: ts.Symbol | undefined;
        for (const symbol of checker.getSymbolsInScope(access, ts.SymbolFlags.All)) {
          if (denoted(checker, symbol) === containerSymbol) {
            localName = symbol.name;
            claimed = symbol;
            break;
          }
          if (symbol.name === className && claimed === undefined) claimed = symbol;
        }
        if (localName !== undefined && claimed !== undefined) {
          // `import type { C }` binds the name for types only, so a
          // value use of it is TS1361 rather than a widening.
          const typeOnly = (claimed.declarations ?? []).some(
            (node) =>
              (ts.isImportSpecifier(node) && (node.isTypeOnly || node.parent.parent.parent.importClause?.isTypeOnly === true)) ||
              (ts.isImportClause(node) && node.isTypeOnly),
          );
          if (typeOnly) {
            throw new Error(
              `${localName} is imported with \`import type\` in ${path.resolve(file.fileName)}, so ` +
                `\`${localName}.${memberName}(…)\` there would be a value use of a type-only ` +
                'binding. Make that import a value import first.',
            );
          }
        }
        if (localName === undefined) {
          if (claimed !== undefined) {
            throw new Error(
              `"${className}" already means something else at ${locationOf(file, start)}, so the ` +
                'class cannot be named there',
            );
          }
          if (!(ts.getCombinedModifierFlags(container) & ts.ModifierFlags.Export)) {
            throw new Error(
              `${className} is not exported from ${path.resolve(sourceFile.fileName)}, so ` +
                `${locationOf(file, start)} could not name it`,
            );
          }
          localName = className;
          needsImport.add(file);
        }
        editIn(file, start, access.expression.getEnd(), localName);
      }

      for (const file of needsImport) {
        for (const edit of importEdits(session, file, className, path.resolve(sourceFile.fileName))) {
          const key = path.resolve(file.fileName);
          changes.set(key, [...(changes.get(key) ?? []), edit]);
        }
      }

      const insertion = staticInsertion(member, sourceFile);
      editIn(sourceFile, insertion.offset, insertion.offset, insertion.text);
    } else {
      if (!ts.isMethodDeclaration(member)) {
        throw new Error(
          `${where} is a property, and a property has no parameter to promote to a receiver. ` +
            'Only a static method has a non-static form this tool can write.',
        );
      }
      if (input.receiver === undefined) {
        throw new Error(
          'to: "instance" needs `receiver`: the parameter that becomes the receiver, so ' +
            `\`${className}.${memberName}(a, b)\` can be rewritten as \`a.${memberName}(b)\``,
        );
      }

      const parameters = member.parameters;
      const thisParameter = parameters.find(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'this',
      );
      const receiver = parameters.find(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === input.receiver,
      );
      if (!receiver || receiver === thisParameter) {
        const names = parameters
          .filter((parameter) => parameter !== thisParameter)
          .map((parameter) => parameter.name.getText(sourceFile))
          .join(', ');
        throw new Error(
          `${where} has no parameter named "${input.receiver}"; its parameters are: ${names || '(none)'}`,
        );
      }
      if (receiver.dotDotDotToken) {
        throw new Error(`"${input.receiver}" is a rest parameter and collects many arguments`);
      }
      if (!ts.isIdentifier(receiver.name)) {
        throw new Error(`"${input.receiver}" is destructured, so there is no single value to become \`this\``);
      }

      // The receiver has to be exactly the declaring class. A supertype
      // would give the body a `this` it cannot use; a subtype would let
      // call sites through that the parameter refused; a union would do
      // both.
      const declaredType = checker.getDeclaredTypeOfSymbol(containerSymbol);
      const receiverType = checker.getTypeAtLocation(receiver);
      if (receiverType !== declaredType) {
        throw new Error(
          `"${receiver.name.text}" is typed \`${checker.typeToString(receiverType)}\`, not ` +
            `\`${className}\`. A receiver has exactly the type of the class that declares the ` +
            `method; moving a method onto the class of one of its parameters is a different ` +
            'operation (ts/refactors/move-instance-method).',
        );
      }

      const receiverSymbol = checker.getSymbolAtLocation(receiver.name);
      const references: ts.Identifier[] = [];
      const shorthands: ts.ShorthandPropertyAssignment[] = [];
      const collect = (node: ts.Node): void => {
        if (node === receiver.name) return;
        if (ts.isShorthandPropertyAssignment(node)) {
          if (checker.getShorthandAssignmentValueSymbol(node) === receiverSymbol) {
            shorthands.push(node);
          }
          return;
        }
        if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === receiverSymbol) {
          references.push(node);
          return;
        }
        node.forEachChild(collect);
      };
      member.forEachChild(collect);

      if (shorthands.length > 0) {
        throw new Error(
          `"${receiver.name.text}" is used as a shorthand property at ` +
            `${locationOf(sourceFile, shorthands[0]!.getStart(sourceFile))}; \`this\` cannot be ` +
            'written that way',
        );
      }
      for (const reference of references) {
        if (insideOwnThis(reference, member)) {
          throw new Error(
            `"${receiver.name.text}" is read at ${locationOf(sourceFile, reference.getStart(sourceFile))}, ` +
              'inside a function that binds its own `this`, so the substitution would resolve to ' +
              'a different receiver there',
          );
        }
      }
      const assigned = classifyReferences(
        session,
        path.resolve(sourceFile.fileName),
        receiver.name.getStart(sourceFile),
      ).filter(isWrite);
      if (assigned.length > 0) {
        throw new Error(
          `"${receiver.name.text}" is assigned at ` +
            `${assigned.map((write) => `${write.file}:${write.line + 1}:${write.character + 1}`).join(', ')}; ` +
            '`this` cannot be reassigned',
        );
      }

      const survey = surveyCallSites(session, target.file, target.offset, memberName);
      assertOnlyCalls(memberName, survey, `making "${memberName}" an instance method`);

      const removedNames = new Map<string, Set<ts.Node>>();
      const touched = new Map<string, ts.SourceFile>();
      for (const reference of survey.calls) {
        const { call, sourceFile: callFile, signature } = resolveCall(
          checker,
          reference,
          member,
          memberName,
        );
        const callee = call.expression;
        if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken) {
          throw new Error(
            `The call at ${locationOf(callFile, call.getStart(callFile))} does not reach ` +
              `${where} as \`${className}.${memberName}\`, so the receiver cannot be moved into ` +
              'its place',
          );
        }
        const qualifier = checker.getSymbolAtLocation(callee.expression);
        if (qualifier === undefined || denoted(checker, qualifier) !== containerSymbol) {
          throw new Error(
            `The call at ${locationOf(callFile, call.getStart(callFile))} reaches ${where} ` +
              `through \`${callee.expression.getText(callFile)}\`, which this rewrite cannot ` +
              'describe',
          );
        }

        // The argument's position in the *resolved* signature. A `this`
        // parameter is declared and never passed, so the declaration
        // index is one too high and deleting by it deletes the wrong
        // argument.
        const index = argumentIndexOf(signature, receiver);
        if (index === -1) {
          throw new Error(
            `"${receiver.name.text}" has no slot in the signature resolved at ` +
              locationOf(callFile, call.getStart(callFile)),
          );
        }
        const args = call.arguments ?? [];
        const argument = args[index];
        if (!argument) {
          throw new Error(
            `The call at ${locationOf(callFile, call.getStart(callFile))} omits ` +
              `"${receiver.name.text}", so there is no receiver to move; it takes the default ` +
              'instead, which an instance method has no way to express',
          );
        }
        const before = args.slice(0, index).filter((other) => mayHaveEffects(other));
        if (before.length > 0) {
          throw new Error(
            `The call at ${locationOf(callFile, call.getStart(callFile))} evaluates ` +
              `\`${before[0]!.getText(callFile)}\` before "${receiver.name.text}", and the ` +
              'receiver is evaluated first once it moves left of the dot',
          );
        }
        if (index > 0) {
          warnings.push(
            `${locationOf(callFile, call.getStart(callFile))} passes the receiver as argument ` +
              `${String(index + 1)}, and it is evaluated first once it moves left of the dot. ` +
              'The arguments it overtakes call nothing, but a property read among them runs a ' +
              'getter if one is declared, and that is an effect no syntactic check sees.',
          );
        }

        const position = callFile.getLineAndCharacterOfPosition(call.getStart(callFile));
        callSites.push({
          file: path.resolve(callFile.fileName),
          line: position.line,
          character: position.character,
        });

        const argumentText = argument.getText(callFile);
        const receiverText = wrapReceiver(argument, callee.expression)
          ? `(${argumentText})`
          : argumentText;
        editIn(callFile, callee.expression.getStart(callFile), callee.expression.getEnd(), receiverText);
        const span = removalRange(args, index, callFile);
        editIn(callFile, span.start, span.end, '');

        const key = path.resolve(callFile.fileName);
        touched.set(key, callFile);
        const removed = removedNames.get(key) ?? new Set<ts.Node>();
        if (ts.isIdentifier(callee.expression)) removed.add(callee.expression);
        removedNames.set(key, removed);
      }

      // Declaration: drop `static`, drop the receiver (and the `this`
      // parameter, whose annotation typed a receiver nobody read), and
      // let the body say `this`.
      const keyword = (ts.getModifiers(member) ?? []).find(
        (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
      )!;
      editIn(sourceFile, keyword.getStart(sourceFile), afterStatic(member, keyword).getStart(sourceFile), '');

      const remove = [parameters.indexOf(receiver)];
      if (thisParameter) remove.unshift(parameters.indexOf(thisParameter));
      const removal = parameterRemoval(parameters, remove.sort((a, b) => a - b), sourceFile);
      // A reference inside the removal span would be edited twice —
      // once as itself and once as part of the rewritten parameter list
      // — and `applyTextEdits` rejects the overlap rather than picking
      // one. Reachable only through a parameter default that reads the
      // receiver, which is legal code this tool declines to write.
      const inside = references.filter(
        (reference) =>
          reference.getStart(sourceFile) >= removal.start && reference.getEnd() <= removal.end,
      );
      if (inside.length > 0) {
        throw new Error(
          `"${receiver.name.text}" is read at ` +
            `${locationOf(sourceFile, inside[0]!.getStart(sourceFile))}, inside the parameter ` +
            'list this edit rewrites. Move that default into the body first.',
        );
      }
      editIn(sourceFile, removal.start, removal.end, removal.newText);

      for (const reference of references) {
        editIn(sourceFile, reference.getStart(sourceFile), reference.getEnd(), 'this');
      }

      for (const [key, callFile] of touched) {
        if (key === path.resolve(sourceFile.fileName)) continue;
        for (const edit of pruneImport(
          checker,
          callFile,
          containerSymbol,
          removedNames.get(key) ?? new Set<ts.Node>(),
        )) {
          changes.set(key, [...(changes.get(key) ?? []), edit]);
        }
      }
    }

    const edit: WorkspaceEdit = { changes: Object.fromEntries(changes) };
    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output: StaticFormOutput = {
      applied: false,
      edit,
      filesChanged,
      newDiagnostics,
      warnings,
      callSites: callSites.sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character,
      ),
    };
    if (input.apply !== true || newDiagnostics.length > 0) return output;

    session.invalidate(await applyWorkspaceEdit(edit));
    return { ...output, applied: true };
  },
};
