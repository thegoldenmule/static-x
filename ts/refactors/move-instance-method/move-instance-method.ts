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
import { relativeSpecifier, resolvedModuleOf, scopeAt } from '../imports.js';
import { reindent } from '../layout.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences } from '../references.js';
import { userPreferences } from '../refactor-action.js';
import {
  argumentIndexOf,
  assertOnlyCalls,
  locationOf,
  resolveCall,
  surveyCallSites,
} from '../signatures.js';
import { mayHaveEffects, needsParentheses, sameBinding, unalias } from '../substitution.js';

/**
 * Moves a method off the class that declares it and onto the class of
 * one of its parameters or one of its fields, flipping the receiver so
 * `a.m(b, c)` becomes `b.m(a, c)` — ReSharper's Move Instance Method.
 *
 * This is the one entry in the index that ports to TypeScript unchanged.
 * A TS class carries state and prototype methods exactly as a C# type
 * does, so "the method reads more of B than of A" means the same thing
 * in both languages and the fix is the same edit.
 *
 * **The receiver flip is the whole tool, and every part of it can go
 * wrong while still compiling.**
 *
 * - *Argument order changes at every call site.* The argument that
 *   becomes the receiver is found through the checker-resolved
 *   signature, never by counting commas: a `this` parameter occupies a
 *   declaration slot and no argument slot, and an omitted optional means
 *   the argument may not be there at all.
 * - *Evaluation order changes.* The old receiver was evaluated first and
 *   is now an argument; the new receiver was an argument and is now
 *   evaluated first. Anything with effects on either side of that swap
 *   is refused rather than reordered.
 * - *`this.x` in the body becomes `<oldReceiver>.x`*, which only
 *   compiles if `x` is visible from B. A `private` or `protected` member
 *   is not, and the refusal names it — the compiler's own message would
 *   land on generated text and say nothing about what to do.
 * - *The old receiver may be unused.* `stampOn(invoice, note)` that only
 *   touches `invoice` needs no parameter at all, and adding one nobody
 *   passes would be a wrong signature that still typechecks at the sites
 *   this tool rewrote.
 *
 * **`keepDelegate` decides whether call sites are touched at all.** With
 * it, the class keeps `m(b, c) { return b.m(this, c); }` and every
 * existing caller goes on working unchanged — which is the only way to
 * move a method that escapes as a value. Without it every use has to be
 * a call this rewrite can describe, and an escape is a refusal
 * (`assertOnlyCalls`): at an escape the signature is checked by
 * assignability, so a flipped parameter list compiles and misbehaves.
 */

export interface MoveInstanceMethodInput {
  /** Method to move, by name. */
  symbol?: string;
  /** Class the method is declared on, when the name is not unique. */
  class?: string;
  file?: string;
  line?: number;
  character?: number;
  /**
   * The parameter, or the field of the declaring class, whose type
   * receives the method.
   */
  to: string;
  /** Leave a delegating method behind, so callers are untouched. */
  keepDelegate?: boolean;
  apply?: boolean;
}

export interface CallSitePosition {
  file: string;
  line: number;
  character: number;
}

export interface MoveInstanceMethodOutput extends RefactorOutput {
  /** Every call the edit flips, in the pre-edit tree. */
  callSites: CallSitePosition[];
}

/** Where an import has to come from, as the destination must write it. */
type ImportOrigin = { kind: 'file'; file: string } | { kind: 'package'; text: string };

interface ImportRequest {
  /** Local name to bind at the destination. */
  name: string;
  origin: ImportOrigin;
  /** Exported name, when the local name is an alias of it. */
  propertyName?: string;
  form: 'named' | 'default' | 'namespace';
  typeOnly: boolean;
}

/** What `to` named: a parameter of the method, or a field of the class. */
type Destination =
  | { kind: 'parameter'; parameter: ts.ParameterDeclaration; index: number }
  /** A property declaration, or the constructor parameter that declares one. */
  | { kind: 'field'; field: ts.PropertyDeclaration | ts.ParameterDeclaration };

interface Rewrite {
  start: number;
  end: number;
  newText: string;
}

/* ------------------------------------------------------------------ */
/* Small shared shapes, in the spellings this tool needs               */
/* ------------------------------------------------------------------ */

/** The class a resolved target declares a member on. */
function containerOf(declaration: ts.Node): ts.ClassLikeDeclaration | undefined {
  const parent = declaration.parent as ts.Node | undefined;
  return parent && ts.isClassLike(parent) ? parent : undefined;
}

/**
 * Resolve the method to move. `class` narrows before `resolveTarget`
 * would refuse: `record` on two unrelated classes is two symbols, and
 * picking either without being told is how a tool refactors the wrong
 * one.
 */
function resolveMethod(
  session: TsProjectSession,
  input: MoveInstanceMethodInput,
): ResolvedTarget {
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
 * An identifier that refers to something rather than naming it. What
 * remains after the name positions are excluded is the set whose meaning
 * the surrounding scope decides — which is exactly the set that has to
 * still resolve after the code moves.
 */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertySignature(parent) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if (ts.isMethodSignature(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isImportClause(parent) && parent.name === node) return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if (ts.isBreakOrContinueStatement(parent) && parent.label === node) return false;
  if (parent.kind === ts.SyntaxKind.MetaProperty) return false;
  return true;
}

/** Every identifier in `root` that refers to something. */
function referencesIn(root: ts.Node): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isReference(node)) found.push(node);
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}

/** Every identifier text used anywhere in a node, name positions included. */
function namesUsedIn(root: ts.Node): Set<string> {
  const used = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) used.add(node.text);
    node.forEachChild(visit);
  };
  visit(root);
  return used;
}

/**
 * The whole lines a node occupies, together with the blank line that
 * separated it from what came before.
 *
 * Taking the blank line *before* rather than after is what keeps the two
 * cases from fighting: the last member of a class has a blank line above
 * it and its closing brace below. The exception is a node that opens its
 * container, where there is no preceding blank to take and keeping the
 * following one would open the body with an empty line.
 */
function lineSpanOf(node: ts.Node, sourceFile: ts.SourceFile): { start: number; end: number } {
  const text = sourceFile.getFullText();
  const lineStartAt = (offset: number): number => {
    let at = offset;
    while (at > 0 && text[at - 1] !== '\n') at--;
    return at;
  };
  let start = lineStartAt(node.getStart(sourceFile, true));
  while (start > 0) {
    const previous = lineStartAt(start - 1);
    if (text.slice(previous, start).trim() !== '') break;
    start = previous;
  }
  let end = node.getEnd();
  while (end < text.length && text[end] !== '\n') end++;
  if (end < text.length) end++;
  if (text.slice(0, start).trimEnd().endsWith('{')) {
    for (let lineEnd = text.indexOf('\n', end); lineEnd !== -1; lineEnd = text.indexOf('\n', end)) {
      if (text.slice(end, lineEnd).trim() !== '') break;
      end = lineEnd + 1;
    }
  }
  return { start, end };
}

/**
 * Blank lines a removal span opens and closes with. A span swallows the
 * separators around the member it removes, so a replacement — the
 * delegate — has to put them back or the member that follows welds
 * itself to it.
 */
function blankLinesAround(
  text: string,
  span: { start: number; end: number },
): { before: string; after: string } {
  const lines = text.slice(span.start, span.end).split('\n');
  let before = 0;
  while (before < lines.length - 1 && lines[before]!.trim() === '') before++;
  let after = 0;
  for (let index = lines.length - 2; index > before && lines[index]!.trim() === ''; index--) {
    after++;
  }
  return { before: '\n'.repeat(before), after: '\n'.repeat(after) };
}

/**
 * The span that deletes one element of a comma-separated list along with
 * the comma joining it to its neighbours. Deleting forward keeps the
 * next element's own leading layout; the last element has no next, so
 * the preceding comma is eaten instead.
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

/** Column a node starts at, which is the indent its text assumes. */
function columnOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, true)).character;
}

/** Whether a node contains a template literal spanning several lines. */
function hasMultilineTemplate(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (
      (ts.isTemplateExpression(child) || ts.isNoSubstitutionTemplateLiteral(child)) &&
      child.getText(sourceFile).includes('\n')
    ) {
      found = true;
      return;
    }
    child.forEachChild(visit);
  };
  visit(node);
  return found;
}

/**
 * Whether the argument that becomes the receiver has to be wrapped when
 * it moves to the left of a property access.
 *
 * Two authorities, because each catches what the other misses. The
 * factory's parenthesizer is the compiler's own rule for this exact
 * position — it knows `new Foo` needs parentheses and `new Foo()` does
 * not — while `needsParentheses` is this repo's conservative
 * operand-position test, and it is the one that wraps an object literal.
 */
function wrapReceiver(argument: ts.Expression, site: ts.Node): boolean {
  const access = ts.factory.createPropertyAccessExpression(argument, 'x');
  return (
    (ts.isParenthesizedExpression(access.expression) && !ts.isParenthesizedExpression(argument)) ||
    needsParentheses(argument, site)
  );
}

/* ------------------------------------------------------------------ */
/* `this` and `super` in the body                                      */
/* ------------------------------------------------------------------ */

interface ReceiverUse {
  /** `this` nodes whose receiver is the method's own. */
  outer: ts.Node[];
  /** `this` inside a nested function, which binds its own receiver. */
  nested: ts.Node[];
  superAt?: ts.Node;
}

/**
 * Where the method reads its receiver.
 *
 * A nested `function`, method, accessor, constructor or class binds its
 * own `this`, so a `this` inside one says nothing about this method's
 * receiver — and, for the same reason, means exactly what it meant once
 * the method lives on another class. Those are left alone; an arrow does
 * not bind its own, so it is followed.
 */
function receiverUses(member: ts.MethodDeclaration): ReceiverUse {
  const outer: ts.Node[] = [];
  const nested: ts.Node[] = [];
  let superAt: ts.Node | undefined;
  const visit = (node: ts.Node, ownThis: boolean): void => {
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      (ownThis ? nested : outer).push(node);
      return;
    }
    if (node.kind === ts.SyntaxKind.SuperKeyword) {
      superAt ??= node;
      return;
    }
    const binds =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassLike(node);
    node.forEachChild((child) => visit(child, ownThis || binds));
  };
  member.forEachChild((child) => visit(child, false));
  return { outer, nested, ...(superAt ? { superAt } : {}) };
}

/** Whether a node sits on the left of an assignment or an increment. */
function isWritten(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) return false;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return true;
  }
  return (
    (ts.isPostfixUnaryExpression(parent) || ts.isPrefixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

/* ------------------------------------------------------------------ */
/* Imports                                                             */
/* ------------------------------------------------------------------ */

/** Statement text for one import request, as the project writes imports. */
function importStatement(
  session: TsProjectSession,
  fromFile: string,
  request: ImportRequest,
): string {
  const preferences = userPreferences(session);
  const quote = preferences.quotePreference === 'double' ? '"' : "'";
  const specifier =
    request.origin.kind === 'package'
      ? request.origin.text
      : relativeSpecifier(
          fromFile,
          request.origin.file,
          preferences.importModuleSpecifierEnding === 'js',
        );
  const modifier = request.typeOnly ? 'type ' : '';
  const alias =
    request.propertyName && request.propertyName !== request.name
      ? `${request.propertyName} as ${request.name}`
      : request.name;
  const clause =
    request.form === 'namespace'
      ? `* as ${request.name}`
      : request.form === 'default'
        ? request.name
        : `{ ${alias} }`;
  return `import ${modifier}${clause} from ${quote}${specifier}${quote};`;
}

/**
 * What the pruning pass took out of a file, so the pass that adds
 * imports can avoid anchoring to it. An insertion anchored to the end of
 * a statement another edit deletes sits inside that deletion, and
 * `applyTextEdits` rejects the pair as overlapping.
 */
interface Pruned {
  edits: TextEdit[];
  statements: Set<ts.ImportDeclaration>;
  specifiers: Set<ts.ImportSpecifier>;
}

const NOTHING_PRUNED: Pruned = {
  edits: [],
  statements: new Set<ts.ImportDeclaration>(),
  specifiers: new Set<ts.ImportSpecifier>(),
};

/**
 * Edits that bind `requests` in `file`. A name is folded into an
 * existing named import from the same module where there is one, so a
 * file never grows two import statements for one module.
 */
function importEdits(
  session: TsProjectSession,
  file: string,
  requests: readonly ImportRequest[],
  pruned: Pruned,
): TextEdit[] {
  const sourceFile = session.program().getSourceFile(file);
  if (!sourceFile) return [];

  const at = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset);
  const edits: TextEdit[] = [];
  const fresh: ImportRequest[] = [];
  const imports = sourceFile.statements
    .filter(ts.isImportDeclaration)
    .filter((declaration) => !pruned.statements.has(declaration));

  for (const request of requests) {
    const target = request.origin.kind === 'file' ? request.origin.file : undefined;
    let anchor: ts.ImportSpecifier | undefined;
    if (request.form === 'named' && target !== undefined) {
      for (const declaration of imports) {
        const bindings = declaration.importClause?.namedBindings;
        if (
          bindings === undefined ||
          !ts.isNamedImports(bindings) ||
          declaration.importClause?.isTypeOnly !== request.typeOnly ||
          resolvedModuleOf(declaration, session.program().getCompilerOptions()) !== target
        ) {
          continue;
        }
        const surviving = bindings.elements.filter((element) => !pruned.specifiers.has(element));
        if (surviving.length > 0) anchor = surviving[surviving.length - 1];
        break;
      }
    }
    if (!anchor) {
      fresh.push(request);
      continue;
    }
    const alias =
      request.propertyName && request.propertyName !== request.name
        ? `${request.propertyName} as ${request.name}`
        : request.name;
    edits.push({
      range: { start: at(anchor.getEnd()), end: at(anchor.getEnd()) },
      newText: `, ${alias}`,
    });
  }

  if (fresh.length > 0) {
    const text = fresh.map((request) => importStatement(session, file, request)).join('\n');
    const lastImport = imports[imports.length - 1];
    const displaced = [...pruned.statements].sort((a, b) => a.pos - b.pos)[0];
    if (lastImport) {
      const end = lastImport.getEnd();
      edits.push({ range: { start: at(end), end: at(end) }, newText: `\n${text}` });
    } else if (displaced) {
      // Every import this file had is going: the new block takes the
      // vacated lines, so the blank line that followed them is still the
      // one blank line between imports and code.
      const start = lineSpanOf(displaced, sourceFile).start;
      edits.push({ range: { start: at(start), end: at(start) }, newText: `${text}\n` });
    } else {
      const first = sourceFile.statements[0];
      const start = first ? first.getStart(sourceFile, true) : 0;
      edits.push({ range: { start: at(start), end: at(start) }, newText: `${text}\n\n` });
    }
  }
  return edits;
}

/**
 * Import specifiers in `sourceFile` that nothing refers to once `dead`
 * is gone.
 *
 * Not tidiness: under `noUnusedLocals` the import the move orphans is
 * TS6133, which the guard reports as a diagnostic the edit introduced
 * and refuses the whole move over. The class that only imported `Invoice`
 * to type the parameter this rewrite removes is the common case.
 */
function unusedImportEdits(
  session: TsProjectSession,
  sourceFile: ts.SourceFile,
  dead: ReadonlySet<ts.Node>,
): Pruned {
  const checker = session.checker();
  const live = new Set<ts.Symbol>();
  // `export { A }` with no module specifier refers to the local binding
  // through a symbol of its own, so it is matched by name instead.
  const reExported = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier === undefined) {
      const clause = node.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          reExported.add((element.propertyName ?? element.name).text);
        }
      }
      return;
    }
    if (ts.isIdentifier(node) && isReference(node) && !dead.has(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) live.add(symbol);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);

  const at = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset);
  const edits: TextEdit[] = [];
  const statements = new Set<ts.ImportDeclaration>();
  const specifiers = new Set<ts.ImportSpecifier>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const orphans = bindings.elements.filter((element) => {
      const symbol = checker.getSymbolAtLocation(element.name);
      return symbol !== undefined && !live.has(symbol) && !reExported.has(element.name.text);
    });
    if (orphans.length === 0) continue;
    for (const orphan of orphans) specifiers.add(orphan);

    const survivors = bindings.elements.filter((element) => !orphans.includes(element));
    if (survivors.length > 0) {
      // One replacement of the whole clause rather than one deletion per
      // name: two deletions in the same list overlap at the comma
      // between them.
      edits.push({
        range: { start: at(bindings.getStart(sourceFile)), end: at(bindings.getEnd()) },
        newText: `{ ${survivors.map((element) => element.getText(sourceFile)).join(', ')} }`,
      });
      continue;
    }
    const defaultName = statement.importClause?.name;
    if (defaultName) {
      edits.push({
        range: { start: at(defaultName.getEnd()), end: at(bindings.getEnd()) },
        newText: '',
      });
      continue;
    }
    const span = lineSpanOf(statement, sourceFile);
    edits.push({ range: { start: at(span.start), end: at(span.end) }, newText: '' });
    statements.add(statement);
  }
  return { edits, statements, specifiers };
}

/**
 * Imports the destination class's file needs so the moved method still
 * means what it meant.
 *
 * Every free name in the method is re-resolved against the destination's
 * scope. One already bound there to the same binding needs nothing; one
 * bound there to a *different* binding is a refusal, because that is the
 * failure the guard cannot see — the code compiles and computes
 * something else. Everything left needs an import, written from the
 * binding the source file used, so a package specifier survives as
 * itself and a relative one is re-based.
 */
function dependencyImports(
  session: TsProjectSession,
  options: {
    member: ts.MethodDeclaration;
    /** Whether a node is part of the method, and so travels with it. */
    inMember: (node: ts.Node) => boolean;
    /** Nodes the rewrite removes, whose names do not travel. */
    dropped: (node: ts.Node) => boolean;
    destinationFile: string;
    destinationScope: ts.Node;
    where: string;
  },
): ImportRequest[] {
  const { member, inMember, dropped, destinationFile, destinationScope, where } = options;
  const checker = session.checker();
  const scope = scopeAt(checker, destinationScope);
  const requests: ImportRequest[] = [];

  for (const node of referencesIn(member)) {
    if (dropped(node)) continue;
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) continue;
    const declarations = symbol.declarations ?? [];
    if (declarations.length > 0 && declarations.every(inMember)) continue;
    const resolved = unalias(checker, symbol);
    if (!(resolved.declarations ?? []).some((home) => ts.isExternalModule(home.getSourceFile()))) {
      continue;
    }

    const there = scope.get(node.text);
    if (there !== undefined) {
      if (!sameBinding(checker, there, symbol)) {
        throw new Error(
          `"${node.text}" means something different in ${destinationFile}, so ${where} would ` +
            'silently change meaning if it moved there',
        );
      }
      continue;
    }
    if (
      declarations.some(
        (home) => path.resolve(home.getSourceFile().fileName) === destinationFile,
      )
    ) {
      continue;
    }

    const typeOnly = (resolved.flags & ts.SymbolFlags.Value) === 0;
    const binding = declarations[0];
    const specifierOf = (statement: ts.ImportDeclaration): ImportOrigin => {
      const origin = resolvedModuleOf(statement, session.program().getCompilerOptions());
      return origin === undefined
        ? { kind: 'package', text: (statement.moduleSpecifier as ts.StringLiteral).text }
        : { kind: 'file', file: origin };
    };

    if (
      binding &&
      ts.isImportSpecifier(binding) &&
      ts.isImportDeclaration(binding.parent.parent.parent)
    ) {
      const statement = binding.parent.parent.parent;
      requests.push({
        name: node.text,
        origin: specifierOf(statement),
        ...(binding.propertyName ? { propertyName: binding.propertyName.text } : {}),
        form: 'named',
        typeOnly: typeOnly || binding.isTypeOnly || statement.importClause!.isTypeOnly,
      });
      continue;
    }
    if (binding && (ts.isNamespaceImport(binding) || ts.isImportClause(binding))) {
      const statement = ts.isNamespaceImport(binding) ? binding.parent.parent : binding.parent;
      if (ts.isImportDeclaration(statement)) {
        requests.push({
          name: node.text,
          origin: specifierOf(statement),
          form: ts.isNamespaceImport(binding) ? 'namespace' : 'default',
          typeOnly,
        });
        continue;
      }
    }

    // A declaration in the file being left: the destination can only
    // name it if that file exports it.
    const home = binding?.getSourceFile();
    if (!home) continue;
    const moduleSymbol = checker.getSymbolAtLocation(home);
    const exported =
      moduleSymbol !== undefined &&
      checker.getExportsOfModule(moduleSymbol).some((candidate) => candidate.name === node.text);
    if (!exported) {
      throw new Error(
        `${where} reads "${node.text}", which ${path.resolve(home.fileName)} does not export, so ` +
          `${destinationFile} cannot name it`,
      );
    }
    requests.push({
      name: node.text,
      origin: { kind: 'file', file: path.resolve(home.fileName) },
      form: 'named',
      typeOnly,
    });
  }
  return requests;
}

/* ------------------------------------------------------------------ */
/* Naming the old receiver                                             */
/* ------------------------------------------------------------------ */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A parameter name for the receiver the method used to have. Derived
 * from the class name, then made free of everything the method already
 * mentions — a parameter that shadowed a function the body calls would
 * compile and call the wrong thing.
 */
function receiverParameterName(className: string, taken: ReadonlySet<string>): string {
  let base = className.charAt(0).toLowerCase() + className.slice(1);
  if (base === className || !IDENTIFIER.test(base)) base = `a${className}`;
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    if (!taken.has(`${base}${suffix}`)) return `${base}${suffix}`;
  }
}

/* ------------------------------------------------------------------ */

export const moveInstanceMethod: Tool<
  MoveInstanceMethodInput,
  MoveInstanceMethodOutput,
  TsProjectSession
> = {
  name: 'ts/refactors/move-instance-method',
  description:
    "Moves an instance method onto the class it envies and flips the receiver — ReSharper's " +
    'Move Instance Method. `to` names either a parameter of the method or a field of the ' +
    'declaring class; the class of that type receives the method. The chosen parameter becomes ' +
    '`this` in the body, the old `this` becomes an explicit first parameter (or is dropped when ' +
    'the body never reads it), and every call site is rewritten: `a.m(b, c)` becomes ' +
    '`b.m(a, c)` for a parameter destination and `a.f.m(a, c)` for a field one. The argument ' +
    'that becomes the receiver is located through the checker-resolved signature, never by ' +
    'counting commas. keepDelegate leaves `m(b, c) { return b.m(this, c); }` behind so existing ' +
    'callers are untouched; without it every use must be a call this rewrite can describe and ' +
    'an escape is a refusal, since at an escape the signature is checked by assignability and a ' +
    'flipped parameter list compiles and misbehaves. Imports the moved body needs are written ' +
    'at the destination and the ones it orphans are removed. Refuses: a `to` whose type is not ' +
    'a class in this project, a generic class on either end, a method the hierarchy shares, a ' +
    'body reading `super`, an overload set, a destination that already declares the name, a ' +
    '`this.x` naming a private or protected member of the class being left, a recursive method, ' +
    'a call site whose receiver or preceding arguments do work (the swap reorders them), a call ' +
    'that omits the destination argument, and a private destination field no call site could ' +
    'reach. Dry-run by default; apply: true writes to disk unless the typecheck reports ' +
    'newDiagnostics.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      symbol: { type: 'string', description: 'Method name to target' },
      class: {
        type: 'string',
        description: 'Class the method is declared on, when the name is not unique',
      },
      to: {
        type: 'string',
        description:
          'Parameter of the method, or field of the declaring class, whose type receives it',
      },
      keepDelegate: {
        type: 'boolean',
        description:
          'Leave a delegating method behind so existing callers are untouched (default false)',
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
        description: 'Every call the edit flips, in the pre-edit tree',
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
    if (typeof input.to !== 'string' || input.to.trim() === '') {
      throw new Error('`to` names the parameter or field whose type receives the method');
    }
    const checker = session.checker();
    const warnings: string[] = [];

    /* ---------------------------------------------------------------- */
    /* The method                                                        */
    /* ---------------------------------------------------------------- */

    const target = resolveMethod(session, input);
    const declaration = declarationAt(target);
    const sourceFile = target.sourceFile;
    const container = containerOf(declaration);
    if (!container || !ts.isClassDeclaration(container)) {
      throw new Error(
        `"${declaration.name?.getText(sourceFile) ?? input.to}" is not a method of a class ` +
          'declaration. Moving a module-level binding is ts/refactors/move-symbol; moving a ' +
          'static is ts/refactors/move-member.',
      );
    }
    const className = container.name?.text;
    if (className === undefined) {
      throw new Error('The method is declared on an anonymous class, which no signature can name');
    }
    const memberName = declaration.name?.getText(sourceFile) ?? '(unnamed)';
    const where = `${className}.${memberName}`;

    if (!ts.isMethodDeclaration(declaration)) {
      throw new Error(
        `${where} is a ${ts.SyntaxKind[declaration.kind]}; this tool moves instance methods. A ` +
          'property has no receiver to flip and an accessor has no argument list.',
      );
    }
    const member: ts.MethodDeclaration = declaration;
    if (!ts.isIdentifier(member.name)) {
      throw new Error(
        `${where} has a ${ts.isPrivateIdentifier(member.name) ? 'private' : 'computed'} name, ` +
          'which cannot be re-bound on another class',
      );
    }
    if (sourceFile.isDeclarationFile) {
      throw new Error(
        `${sourceFile.fileName} is a declaration file; it describes an implementation this ` +
          'project does not own',
      );
    }

    const modifierFlags = ts.getCombinedModifierFlags(member);
    if (modifierFlags & ts.ModifierFlags.Static) {
      throw new Error(
        `${where} is static, so it has no receiver to flip. Moving a static to another container ` +
          'is ts/refactors/move-member.',
      );
    }
    // Before the body check, which an overload set would fail first: a
    // target resolved by name lands on the first *signature*, and
    // "no body to move" says nothing about what is really in the way.
    if (
      container.members.some(
        (other) =>
          other !== member &&
          ts.isMethodDeclaration(other) &&
          ts.isIdentifier(other.name) &&
          other.name.text === memberName,
      )
    ) {
      throw new Error(
        `${where} is an overload set: its call signatures are separate declarations, and moving ` +
          'the implementation alone would leave them describing a method the class no longer has',
      );
    }
    if (modifierFlags & ts.ModifierFlags.Abstract || !member.body) {
      throw new Error(`${where} has no body to move`);
    }
    if ((ts.getDecorators(member) ?? []).length > 0) {
      throw new Error(
        `${where} is decorated, and a decorator is applied by the class that declares the ` +
          'member — it would run against a different prototype',
      );
    }
    if (member.parameters.some((parameter) => parameter.name.getText(sourceFile) === 'this')) {
      throw new Error(
        `${where} declares an explicit \`this\` parameter, which types the receiver this move ` +
          'replaces. Remove it first.',
      );
    }
    if (container.typeParameters && container.typeParameters.length > 0) {
      throw new Error(
        `${className} is generic, so the receiver parameter this move writes would need type ` +
          'arguments the call sites do not supply',
      );
    }

    // A member the hierarchy shares is not the only declaration of
    // itself: moving one leaves the others behind, still describing a
    // method whose signature has changed shape.
    const hierarchy = memberHierarchy(session, member);
    if (hierarchy.unresolved.length > 0) {
      throw new Error(
        `${className}'s hierarchy cannot be resolved (${hierarchy.unresolved.join(', ')}), so ` +
          'another declaration of this method could be invisible here',
      );
    }
    if (hierarchy.supertypes.length + hierarchy.subtypes.length > 0) {
      const others = [...hierarchy.supertypes, ...hierarchy.subtypes]
        .map((other) => `${other.container} (${other.file}:${other.line + 1})`)
        .join(', ');
      throw new Error(
        `${where} is also declared by ${others}; moving one declaration of a shared member ` +
          'leaves the others behind',
      );
    }

    const receiver = receiverUses(member);
    if (receiver.superAt) {
      throw new Error(
        `${where} reads \`super\` at ` +
          `${locationOf(sourceFile, receiver.superAt.getStart(sourceFile))}. \`super\` names ` +
          `${className}'s base class, and the method would no longer be on ${className}.`,
      );
    }

    /* ---------------------------------------------------------------- */
    /* The destination                                                   */
    /* ---------------------------------------------------------------- */

    const parameterNamed = member.parameters.find(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === input.to,
    );
    const fieldNamed = container.members.find(
      (candidate): candidate is ts.PropertyDeclaration =>
        ts.isPropertyDeclaration(candidate) &&
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === input.to,
    );
    const parameterPropertyNamed = (
      container.members.find(ts.isConstructorDeclaration)?.parameters ?? []
    ).find(
      (parameter): parameter is ts.ParameterPropertyDeclaration =>
        parameter.parent !== undefined &&
        ts.isParameterPropertyDeclaration(parameter, parameter.parent) &&
        ts.isIdentifier(parameter.name) &&
        parameter.name.text === input.to,
    );
    const fieldDeclaration = fieldNamed ?? parameterPropertyNamed;

    if (parameterNamed && fieldDeclaration) {
      throw new Error(
        `"${input.to}" is both a parameter of ${where} and a field of ${className}, and the two ` +
          'produce different call-site rewrites. Rename one of them first.',
      );
    }
    if (!parameterNamed && !fieldDeclaration) {
      const parameters = member.parameters.map((p) => p.name.getText(sourceFile));
      const fields = container.members
        .filter(ts.isPropertyDeclaration)
        .map((p) => p.name.getText(sourceFile));
      throw new Error(
        `"${input.to}" is neither a parameter of ${where} nor a field of ${className}. ` +
          `Parameters: ${parameters.join(', ') || '(none)'}. Fields: ${fields.join(', ') || '(none)'}.`,
      );
    }

    const destination: Destination = parameterNamed
      ? {
          kind: 'parameter',
          parameter: parameterNamed,
          index: member.parameters.indexOf(parameterNamed),
        }
      : { kind: 'field', field: fieldDeclaration! };
    const destinationNode =
      destination.kind === 'parameter' ? destination.parameter : destination.field;

    if (destination.kind === 'parameter') {
      const parameter = destination.parameter;
      if (parameter.dotDotDotToken) {
        throw new Error(`"${input.to}" is a rest parameter, which collects many values`);
      }
      if (!ts.isIdentifier(parameter.name)) {
        throw new Error(
          `"${input.to}" is destructured, so there is no single value to become \`this\``,
        );
      }
      if (parameter.questionToken) {
        throw new Error(
          `"${input.to}" is optional, so a call may pass nothing — and there is no receiver ` +
            'to call the method on',
        );
      }
    } else {
      const flags = ts.getCombinedModifierFlags(destination.field);
      if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) {
        throw new Error(
          `${className}.${input.to} is ${flags & ts.ModifierFlags.Private ? 'private' : 'protected'}, ` +
            `and every call site would have to write \`x.${input.to}.${memberName}(…)\` to reach ` +
            'the moved method',
        );
      }
      if (destination.field.questionToken) {
        throw new Error(
          `${className}.${input.to} is optional, so \`x.${input.to}.${memberName}(…)\` would be a ` +
            'call on a value that may be undefined',
        );
      }
    }

    const destinationType = checker.getTypeAtLocation(destinationNode);
    const destinationSymbol = destinationType.getSymbol();
    const destinationClass = (destinationSymbol?.declarations ?? []).find(ts.isClassDeclaration);
    if (!destinationClass) {
      const described = checker.typeToString(destinationType);
      const asInterface = (destinationSymbol?.declarations ?? []).some(ts.isInterfaceDeclaration);
      throw new Error(
        `"${input.to}" is typed \`${described}\`, which is not a class this tool can write to. ` +
          (asInterface
            ? 'An interface holds no implementations, so there is no body for the method to land in.'
            : 'The receiver of a moved method has to be a class declared in this project.'),
      );
    }
    if (destinationClass === container) {
      throw new Error(`"${input.to}" is typed ${className}, which is where the method already is`);
    }
    if (destinationClass.typeParameters && destinationClass.typeParameters.length > 0) {
      throw new Error(
        `${destinationClass.name?.text ?? 'The destination class'} is generic, and a method moved ` +
          'onto it would be checked against its type parameters rather than the concrete type ' +
          'the body assumes',
      );
    }
    const destinationSource = destinationClass.getSourceFile();
    if (destinationSource.isDeclarationFile || destinationSource.fileName.includes('/node_modules/')) {
      throw new Error(
        `${destinationClass.name?.text ?? '(anonymous)'} is declared in ` +
          `${destinationSource.fileName}, which this project does not own`,
      );
    }
    const destinationName = destinationClass.name?.text;
    if (destinationName === undefined) {
      throw new Error('The destination is an anonymous class, which no import can name');
    }
    if (
      destinationClass.members.some(
        (other) =>
          other.name !== undefined &&
          (ts.isIdentifier(other.name) || ts.isPrivateIdentifier(other.name)) &&
          other.name.text === memberName,
      )
    ) {
      throw new Error(`${destinationName} already declares a member named "${memberName}"`);
    }
    const destinationFile = path.resolve(destinationSource.fileName);
    const sourceFileKey = path.resolve(sourceFile.fileName);

    /* ---------------------------------------------------------------- */
    /* The body                                                          */
    /* ---------------------------------------------------------------- */

    const memberStart = member.getStart(sourceFile, true);
    const memberEnd = member.getEnd();
    const inMember = (node: ts.Node): boolean =>
      node.getSourceFile() === sourceFile &&
      node.getStart() >= memberStart &&
      node.getEnd() <= memberEnd;

    const bodyRewrites: Rewrite[] = [];
    /** `this` nodes that fold into the destination rather than becoming a parameter. */
    const folded = new Set<ts.Node>();

    if (destination.kind === 'field') {
      // Every read of the field inside the body is the new receiver, so
      // `this.printer.wrap(x)` becomes `this.wrap(x)`. References come
      // from the language service rather than a syntactic walk, because
      // `const { printer } = this` reads the field through a binding
      // element whose own symbol is the local, not the property.
      const stray: string[] = [];
      const fieldReferences = classifyReferences(
        session,
        sourceFileKey,
        (destination.field.name as ts.Node).getStart(sourceFile),
      );
      for (const reference of fieldReferences) {
        if (
          path.resolve(reference.node.getSourceFile().fileName) !== sourceFileKey ||
          reference.offset < memberStart ||
          reference.offset >= memberEnd
        ) {
          continue;
        }
        const access = reference.node.parent as ts.Node | undefined;
        if (
          access === undefined ||
          !ts.isPropertyAccessExpression(access) ||
          access.name !== reference.node ||
          access.expression.kind !== ts.SyntaxKind.ThisKeyword
        ) {
          stray.push(locationOf(sourceFile, reference.node.getStart(sourceFile)));
          continue;
        }
        if (isWritten(access)) {
          throw new Error(
            `${where} assigns \`this.${input.to}\` at ` +
              `${locationOf(sourceFile, access.getStart(sourceFile))}, and the destination field ` +
              'becomes `this`, which cannot be assigned',
          );
        }
        folded.add(access.expression);
        bodyRewrites.push({
          start: access.getStart(sourceFile),
          end: access.getEnd(),
          newText: 'this',
        });
      }
      if (stray.length > 0) {
        throw new Error(
          `${where} reaches "${input.to}" other than as \`this.${input.to}\` at ` +
            `${stray.join(', ')}; only the plain field read folds into the new receiver`,
        );
      }
    }

    const survivingThis = receiver.outer.filter((node) => !folded.has(node));
    const usesOldReceiver = survivingThis.length > 0;

    // `this.x` becomes `<oldReceiver>.x`, which only compiles if `x` is
    // reachable from the destination class. The compiler's message for
    // the failure would land on text this tool generated and say nothing
    // about which member caused it, so the member is named here.
    const hidden = new Map<string, string>();
    for (const node of survivingThis) {
      const access = node.parent as ts.Node | undefined;
      if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== node) continue;
      if (ts.isPrivateIdentifier(access.name)) {
        hidden.set(access.name.text, '#private');
        continue;
      }
      const symbol = checker.getSymbolAtLocation(access.name);
      const home = (symbol?.declarations ?? [])[0];
      if (!home) continue;
      const flags = ts.getCombinedModifierFlags(home);
      if (flags & ts.ModifierFlags.Private) hidden.set(access.name.text, 'private');
      else if (flags & ts.ModifierFlags.Protected) hidden.set(access.name.text, 'protected');
    }
    if (hidden.size > 0) {
      const listed = [...hidden].map(([name, kind]) => `${kind} ${className}.${name}`).join(', ');
      throw new Error(
        `${where} reads ${listed}. The old receiver becomes an ordinary parameter, and ` +
          `${destinationName} cannot reach ${hidden.size > 1 ? 'those members' : 'that member'}.`,
      );
    }

    if (receiver.nested.length > 0) {
      warnings.push(
        `${where} contains a nested function with its own \`this\`, which this rewrite leaves ` +
          'alone — it is bound at the call rather than by the enclosing method, so moving the ' +
          'method does not change what it means.',
      );
    }

    const oldReceiverName = usesOldReceiver
      ? receiverParameterName(
          className,
          new Set([...namesUsedIn(member), className, destinationName]),
        )
      : '';

    // The destination parameter becomes `this`. Two spellings cannot
    // survive that: a shorthand property, which has no place to put a
    // keyword, and an assignment, which `this` does not permit.
    if (destination.kind === 'parameter') {
      const parameterSymbol = checker.getSymbolAtLocation(destination.parameter.name);
      const uses: ts.Identifier[] = [];
      const visit = (node: ts.Node): void => {
        if (node === destination.parameter.name) return;
        if (ts.isShorthandPropertyAssignment(node)) {
          if (checker.getShorthandAssignmentValueSymbol(node) === parameterSymbol) {
            throw new Error(
              `"${input.to}" is used as a shorthand property at ` +
                `${locationOf(sourceFile, node.getStart(sourceFile))}; \`this\` cannot be written ` +
                'that way',
            );
          }
          return;
        }
        if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === parameterSymbol) {
          uses.push(node);
          return;
        }
        node.forEachChild(visit);
      };
      member.forEachChild(visit);

      for (const use of uses) {
        if (isWritten(use)) {
          throw new Error(
            `"${input.to}" is assigned at ${locationOf(sourceFile, use.getStart(sourceFile))}; ` +
              '`this` cannot be reassigned',
          );
        }
        for (
          let current = use.parent as ts.Node | undefined;
          current && current !== member;
          current = current.parent
        ) {
          if (
            ts.isFunctionDeclaration(current) ||
            ts.isFunctionExpression(current) ||
            ts.isMethodDeclaration(current) ||
            ts.isConstructorDeclaration(current) ||
            ts.isGetAccessorDeclaration(current) ||
            ts.isSetAccessorDeclaration(current) ||
            ts.isClassLike(current)
          ) {
            throw new Error(
              `"${input.to}" is read at ${locationOf(sourceFile, use.getStart(sourceFile))}, ` +
                'inside a function that binds its own `this`, so the substitution would resolve ' +
                'to a different receiver there',
            );
          }
        }
        if (use.getStart(sourceFile) < member.body.getStart(sourceFile)) {
          throw new Error(
            `"${input.to}" is read at ${locationOf(sourceFile, use.getStart(sourceFile))}, inside ` +
              'the parameter list this edit rewrites. Move that default into the body first.',
          );
        }
        bodyRewrites.push({ start: use.getStart(sourceFile), end: use.getEnd(), newText: 'this' });
      }
    }

    for (const node of survivingThis) {
      bodyRewrites.push({
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        newText: oldReceiverName,
      });
    }

    /* ---------------------------------------------------------------- */
    /* Naming the class being left, at the destination                   */
    /* ---------------------------------------------------------------- */

    const destinationScope = scopeAt(checker, destinationClass);
    const containerSymbol = checker.getSymbolAtLocation(container.name!);
    let localClassName = className;
    let needsClassImport = usesOldReceiver && destinationFile !== sourceFileKey;
    if (needsClassImport) {
      const bound = [...destinationScope.entries()].find(
        ([, candidate]) =>
          containerSymbol !== undefined && sameBinding(checker, candidate, containerSymbol),
      );
      if (bound) {
        localClassName = bound[0];
        needsClassImport = false;
      } else if (destinationScope.has(className)) {
        throw new Error(
          `"${className}" already means something else in ${destinationFile}, so the receiver ` +
            'parameter could not be typed there',
        );
      } else if (!(ts.getCombinedModifierFlags(container) & ts.ModifierFlags.Export)) {
        throw new Error(
          `${className} is not exported from ${sourceFileKey}, so ${destinationFile} cannot name ` +
            'it in the receiver parameter this move writes',
        );
      }
    }

    /* ---------------------------------------------------------------- */
    /* Call sites                                                        */
    /* ---------------------------------------------------------------- */

    const changes = new Map<string, TextEdit[]>();
    const add = (file: string, edit: TextEdit): void => {
      changes.set(file, [...(changes.get(file) ?? []), edit]);
    };
    const editIn = (file: ts.SourceFile, start: number, end: number, newText: string): void => {
      add(path.resolve(file.fileName), {
        range: {
          start: file.getLineAndCharacterOfPosition(start),
          end: file.getLineAndCharacterOfPosition(end),
        },
        newText,
      });
    };
    const callSites: CallSitePosition[] = [];
    const keepDelegate = input.keepDelegate === true;

    if (!keepDelegate) {
      const survey = surveyCallSites(session, target.file, target.offset, memberName);
      assertOnlyCalls(memberName, survey, `flipping the receiver of "${memberName}"`);

      for (const reference of survey.calls) {
        if (
          path.resolve(reference.node.getSourceFile().fileName) === sourceFileKey &&
          reference.offset >= memberStart &&
          reference.offset < memberEnd
        ) {
          throw new Error(
            `${where} calls itself at ` +
              `${locationOf(sourceFile, reference.node.getStart(sourceFile))}. The rewrite would ` +
              'have to edit the text it is moving, and the recursive call would be flipped onto ' +
              'the wrong receiver.',
          );
        }

        const { call, sourceFile: callFile, signature } = resolveCall(
          checker,
          reference,
          member,
          memberName,
        );
        const callee = call.expression;
        if (
          !ts.isCallExpression(call) ||
          !ts.isPropertyAccessExpression(callee) ||
          callee.name !== reference.node
        ) {
          throw new Error(
            `The call at ${locationOf(callFile, call.getStart(callFile))} does not reach ${where} ` +
              `as \`<receiver>.${memberName}\`, so the receiver cannot be moved`,
          );
        }
        if (callee.questionDotToken || call.questionDotToken) {
          throw new Error(
            `The call at ${locationOf(callFile, call.getStart(callFile))} is optionally chained, ` +
              'and the nullish guard would move with the receiver rather than staying where it is',
          );
        }
        const oldReceiver = callee.expression;
        const args = call.arguments;

        // Order of evaluation is the half of this rewrite the typecheck
        // cannot see. The old receiver went first and is now an
        // argument; the new one was an argument and now goes first.
        if (mayHaveEffects(oldReceiver)) {
          throw new Error(
            `The call at ${locationOf(callFile, call.getStart(callFile))} is made on ` +
              `\`${oldReceiver.getText(callFile).slice(0, 48)}\`, which does work. After the flip ` +
              'it is evaluated after the new receiver, and nothing in a typecheck reports the ' +
              'reordering. Hoist it into a local first.',
          );
        }

        const position = callFile.getLineAndCharacterOfPosition(call.getStart(callFile));
        callSites.push({
          file: path.resolve(callFile.fileName),
          line: position.line,
          character: position.character,
        });
        const receiverText = oldReceiver.getText(callFile);

        if (destination.kind === 'field') {
          // `a.m(c)` becomes `a.f.m(a, c)`: the receiver is read twice.
          if (usesOldReceiver && !ts.isIdentifier(oldReceiver) && oldReceiver.kind !== ts.SyntaxKind.ThisKeyword) {
            warnings.push(
              `${locationOf(callFile, call.getStart(callFile))} evaluates ` +
                `\`${receiverText.slice(0, 48)}\` twice after the flip — once for ` +
                `.${input.to} and once as the argument. Nothing in it calls anything, but a ` +
                'property read there runs a getter if one is declared.',
            );
          }
          editIn(callFile, oldReceiver.getEnd(), oldReceiver.getEnd(), `.${input.to}`);
          if (usesOldReceiver) {
            const first = args[0];
            if (first) {
              editIn(callFile, first.getStart(callFile), first.getStart(callFile), `${receiverText}, `);
            } else {
              editIn(callFile, call.arguments.end, call.arguments.end, receiverText);
            }
          }
          continue;
        }

        // The argument's position in the *resolved* signature: a `this`
        // parameter is declared and never passed, so a declaration index
        // is one too high and would rewrite the wrong argument.
        const index = argumentIndexOf(signature, destination.parameter);
        if (index === -1) {
          throw new Error(
            `"${input.to}" has no slot in the signature resolved at ` +
              locationOf(callFile, call.getStart(callFile)),
          );
        }
        const chosen = args[index];
        if (!chosen) {
          throw new Error(
            `The call at ${locationOf(callFile, call.getStart(callFile))} omits "${input.to}", so ` +
              'there is no receiver to move; it takes the default instead, which a receiver has ' +
              'no way to express',
          );
        }
        const before = args.slice(0, index).filter((other) => mayHaveEffects(other));
        if (before.length > 0) {
          throw new Error(
            `The call at ${locationOf(callFile, call.getStart(callFile))} evaluates ` +
              `\`${before[0]!.getText(callFile).slice(0, 48)}\` before "${input.to}", and the new ` +
              'receiver is evaluated first once it moves left of the dot',
          );
        }
        if (index > 0) {
          warnings.push(
            `${locationOf(callFile, call.getStart(callFile))} passes the new receiver as argument ` +
              `${String(index + 1)}, and it is evaluated first once it moves left of the dot. The ` +
              'arguments it overtakes call nothing, but a property read among them runs a getter ' +
              'if one is declared.',
          );
        }

        const chosenText = chosen.getText(callFile);
        editIn(
          callFile,
          oldReceiver.getStart(callFile),
          oldReceiver.getEnd(),
          wrapReceiver(chosen, oldReceiver) ? `(${chosenText})` : chosenText,
        );
        if (!usesOldReceiver) {
          const span = removalRange(args, index, callFile);
          editIn(callFile, span.start, span.end, '');
        } else if (index === 0) {
          // The old receiver takes the vacated slot outright, which is
          // also what keeps the two edits from overlapping at argument 0.
          editIn(callFile, chosen.getStart(callFile), chosen.getEnd(), receiverText);
        } else {
          const first = args[0]!;
          editIn(callFile, first.getStart(callFile), first.getStart(callFile), `${receiverText}, `);
          const span = removalRange(args, index, callFile);
          editIn(callFile, span.start, span.end, '');
        }
      }
    }

    /* ---------------------------------------------------------------- */
    /* The moved text                                                    */
    /* ---------------------------------------------------------------- */

    const signatureRewrites: Rewrite[] = [];
    const dropped: ts.Node[] = [];
    if (destination.kind === 'parameter') {
      const parameters = member.parameters;
      const index = destination.index;
      const newParameter = `${oldReceiverName}: ${localClassName}`;
      if (usesOldReceiver && index === 0) {
        signatureRewrites.push({
          start: parameters[0]!.getStart(sourceFile),
          end: parameters[0]!.getEnd(),
          newText: newParameter,
        });
      } else {
        if (usesOldReceiver) {
          const first = parameters[0]!;
          signatureRewrites.push({
            start: first.getStart(sourceFile),
            end: first.getStart(sourceFile),
            newText: `${newParameter}, `,
          });
        }
        const span = removalRange(parameters, index, sourceFile);
        signatureRewrites.push({ start: span.start, end: span.end, newText: '' });
      }
      dropped.push(destination.parameter);
    } else if (usesOldReceiver) {
      const first = member.parameters[0];
      const at = first ? first.getStart(sourceFile) : member.parameters.pos;
      signatureRewrites.push({
        start: at,
        end: at,
        newText: first
          ? `${oldReceiverName}: ${localClassName}, `
          : `${oldReceiverName}: ${localClassName}`,
      });
    }

    const isDropped = (node: ts.Node): boolean =>
      dropped.some(
        (removed) => node.getStart() >= removed.getStart() && node.getEnd() <= removed.getEnd(),
      );

    // A body rewrite inside the parameter this edit deletes describes
    // text that is about to disappear, so it is discarded rather than
    // left to collide with the deletion. Reachable through a default
    // that reads `this`, which is legal code.
    const rewrites = [
      ...bodyRewrites.filter(
        (rewrite) =>
          !dropped.some(
            (removed) => rewrite.start >= removed.getStart() && rewrite.end <= removed.getEnd(),
          ),
      ),
      ...signatureRewrites,
    ].sort((a, b) => b.start - a.start || b.end - a.end);

    for (const [index, rewrite] of rewrites.entries()) {
      const next = rewrites[index + 1];
      if (next && next.end > rewrite.start) {
        throw new Error(
          `${where} produced overlapping edits at ` +
            `${locationOf(sourceFile, rewrite.start)}; this is a defect in the tool rather than ` +
            'in the code it was given',
        );
      }
    }

    let moved = sourceFile.text.slice(memberStart, memberEnd);
    for (const rewrite of rewrites) {
      moved =
        moved.slice(0, rewrite.start - memberStart) +
        rewrite.newText +
        moved.slice(rewrite.end - memberStart);
    }

    const sourceColumn = columnOf(member, sourceFile);
    const firstDestinationMember = destinationClass.members[0];
    const targetIndent = ' '.repeat(
      firstDestinationMember
        ? columnOf(firstDestinationMember, destinationSource)
        : columnOf(destinationClass, destinationSource) + 2,
    );
    if (hasMultilineTemplate(member, sourceFile)) {
      warnings.push(
        `${where} contains a multi-line template literal, whose indentation is string content ` +
          'rather than layout, so the moved code keeps its original indentation.',
      );
    } else {
      moved = reindent(moved, sourceColumn, targetIndent);
    }

    if (modifierFlags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) {
      warnings.push(
        `${where} is ${modifierFlags & ts.ModifierFlags.Private ? 'private' : 'protected'}, and ` +
          `the moved declaration is private to ${destinationName} instead — every caller inside ` +
          `${className} now reaches a member it may not be allowed to see.`,
      );
    }

    /* ---------------------------------------------------------------- */
    /* The delegate, or the removal                                      */
    /* ---------------------------------------------------------------- */

    const removal = lineSpanOf(member, sourceFile);
    if (keepDelegate) {
      if (member.asteriskToken) {
        throw new Error(
          `${where} is a generator, and a delegate would have to \`yield*\` rather than return — ` +
            'a different body with different completion semantics. Move it without keepDelegate.',
        );
      }
      const forwarded: string[] = [];
      if (usesOldReceiver) forwarded.push('this');
      for (const parameter of member.parameters) {
        if (destination.kind === 'parameter' && parameter === destination.parameter) continue;
        if (!ts.isIdentifier(parameter.name)) {
          throw new Error(
            `${where} destructures the parameter at ` +
              `${locationOf(sourceFile, parameter.getStart(sourceFile))}, which a delegate cannot ` +
              'forward by name. Move it without keepDelegate.',
          );
        }
        forwarded.push(`${parameter.dotDotDotToken ? '...' : ''}${parameter.name.text}`);
      }
      const through =
        destination.kind === 'parameter'
          ? (destination.parameter.name as ts.Identifier).text
          : `this.${input.to}`;
      const head = sourceFile.text
        .slice(member.getStart(sourceFile, true), member.body.getStart(sourceFile))
        .trimEnd();
      const indent = ' '.repeat(sourceColumn);
      // `head` is sliced from the JSDoc's first character, so its own
      // continuation lines keep the indentation they had — only the
      // first line needs one put back.
      const delegate = `${head} {\n${indent}  return ${through}.${memberName}(${forwarded.join(', ')});\n${indent}}`;
      const blanks = blankLinesAround(sourceFile.getFullText(), removal);
      editIn(
        sourceFile,
        removal.start,
        removal.end,
        `${blanks.before}${indent}${delegate}\n${blanks.after}`,
      );
    } else {
      editIn(sourceFile, removal.start, removal.end, '');
    }

    /* ---------------------------------------------------------------- */
    /* Imports                                                           */
    /* ---------------------------------------------------------------- */

    const requests: ImportRequest[] = [];
    const request = (entry: ImportRequest): void => {
      if (!requests.some((other) => other.name === entry.name)) requests.push(entry);
    };
    if (needsClassImport) {
      // Type-only: the receiver parameter is an annotation, and a value
      // import here would close a runtime cycle wherever the class being
      // left already imports the destination.
      request({
        name: className,
        origin: { kind: 'file', file: sourceFileKey },
        form: 'named',
        typeOnly: true,
      });
    }
    if (destinationFile !== sourceFileKey) {
      for (const entry of dependencyImports(session, {
        member,
        inMember,
        dropped: isDropped,
        destinationFile,
        destinationScope: destinationClass,
        where,
      })) {
        request(entry);
      }
    }

    // What the class being left no longer names. With a delegate the
    // signature stays, so only the body's names die; without one the
    // whole declaration goes.
    const dead = new Set<ts.Node>();
    if (destinationFile !== sourceFileKey) {
      for (const node of referencesIn(keepDelegate ? member.body : member)) dead.add(node);
    }
    const pruned =
      dead.size > 0 ? unusedImportEdits(session, sourceFile, dead) : NOTHING_PRUNED;

    for (const edit of importEdits(session, destinationFile, requests, NOTHING_PRUNED)) {
      add(destinationFile, edit);
    }
    for (const edit of pruned.edits) add(sourceFileKey, edit);

    /* ---------------------------------------------------------------- */
    /* Landing the method                                                */
    /* ---------------------------------------------------------------- */

    const last = destinationClass.members[destinationClass.members.length - 1];
    const offset = last ? last.getEnd() : destinationClass.members.end;
    editIn(destinationSource, offset, offset, last ? `\n\n${moved}` : `\n${moved}\n`);

    const edit: WorkspaceEdit = { changes: Object.fromEntries(changes) };
    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output = {
      edit,
      filesChanged,
      newDiagnostics,
      warnings,
      callSites: callSites.sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character,
      ),
    };

    if (input.apply !== true || newDiagnostics.length > 0) return { applied: false, ...output };
    session.invalidate(await applyWorkspaceEdit(edit));
    return { applied: true, ...output };
  },
};
