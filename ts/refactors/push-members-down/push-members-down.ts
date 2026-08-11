import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { memberHierarchy } from '../../ast/hierarchy.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { relativeSpecifier, removeBinding, resolvedModuleOf, scopeAt } from '../imports.js';
import { reindent } from '../layout.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences, isUse } from '../references.js';
import { formatSettings, userPreferences } from '../refactor-action.js';
import { sameBinding, unalias } from '../substitution.js';

/**
 * Copies members off a base class into the subclasses that use them and
 * deletes them from the base — ReSharper's Push Members Down.
 *
 * **The subclass set is not knowable from the base declaration.**
 * `ts.Program` indexes inheritance upward only: a class knows what it
 * extends and nothing knows what extends it. So the receiving set has to
 * be built by scanning every heritage clause in the compilation and
 * resolving each `extends` through the checker, which is the one part of
 * this refactoring no single file contains the knowledge for.
 *
 * That scan can fail to close. `class X extends WithLogging(Base)`
 * resolves to a call expression rather than a class symbol, so the edge
 * is invisible and the closure may be missing a subclass — pushing into
 * a set known to be incomplete is refused rather than attempted. The
 * refusal is narrowed to clauses that could actually hide a subclass of
 * *this* base: an opaque clause whose type or whose named identifiers
 * reach the base or one of its descendants. A mixin over an unrelated
 * class, and the `class extends base` template inside a mixin factory —
 * whose base is a type parameter, so it is a subclass of nothing in
 * particular — leave every other hierarchy in the project pushable.
 *
 * The other refusals are the ones a typecheck cannot decide for itself
 * or would report far from the cause. A member some receiving subclass
 * does not use would be copied there as pure duplication, which
 * compiles perfectly and is exactly what the caller did not ask for; a
 * member the base's own code calls cannot leave, and a member a
 * subclass already declares is not one declaration but two.
 */

export interface PushMembersDownInput {
  /** Base class to push members off, by name. */
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  /** Member names to push down. */
  members: string[];
  /** Subclasses to receive them. Default: every subclass of the base. */
  to?: string[];
  apply?: boolean;
}

export interface PushTarget {
  /** Subclass the members were copied into. */
  container: string;
  /** Absolute path of the file that subclass lives in. */
  file: string;
}

export interface PushMembersDownOutput extends RefactorOutput {
  /** Subclasses that received the members. */
  targets: PushTarget[];
  /** Members pushed, in the order the base declared them. */
  members: string[];
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

interface Span {
  start: number;
  end: number;
}

/** A class in the compilation, with the file it was found in. */
interface FoundClass {
  node: ts.ClassLikeDeclaration;
  sourceFile: ts.SourceFile;
}

/**
 * A heritage clause the scan could not resolve to a class declaration,
 * with whatever the checker could still say about what it derives from.
 */
interface OpaqueClause {
  /** `AuditedFeed extends WithAudit(Feed)`, as the refusal names it. */
  text: string;
  /** Classes the clause's type or its identifiers reach. */
  bases: ts.ClassLikeDeclaration[];
  /**
   * True when the base is a type parameter — the `class extends base`
   * inside a mixin factory. Such a class is a subclass of whatever is
   * passed at each application, and every application is itself a
   * heritage clause this scan reads, so it hides nothing.
   */
  template: boolean;
}

interface Heritage {
  /** Child class to the classes it extends. */
  parents: Map<ts.ClassLikeDeclaration, ts.ClassLikeDeclaration[]>;
  opaque: OpaqueClause[];
}

function containerName(node: ts.ClassLikeDeclaration): string {
  return node.name?.text ?? '(anonymous class)';
}

function fileOf(node: ts.Node): string {
  return path.resolve(node.getSourceFile().fileName);
}

function locate(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${path.resolve(sourceFile.fileName)}:${line + 1}:${character + 1}`;
}

/** Column a node starts at, which is the indent its text assumes. */
function columnOf(node: ts.Node): number {
  const sourceFile = node.getSourceFile();
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, true)).character;
}

/**
 * An identifier that refers to something rather than naming it. What
 * remains after the exclusions is the set of names whose meaning the
 * surrounding scope decides — exactly the set that has to still resolve
 * once the code is copied somewhere else.
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
  if (ts.isGetAccessorDeclaration(parent) && parent.name === node) return false;
  if (ts.isSetAccessorDeclaration(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isImportClause(parent) && parent.name === node) return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if (ts.isBreakOrContinueStatement(parent) && parent.label === node) return false;
  if (parent.kind === ts.SyntaxKind.MetaProperty) return false;
  return true;
}

/** Every identifier under `root` that refers to something. */
function referencesIn(root: ts.Node): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isReference(node)) found.push(node);
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}

/** Every class and class expression in the compilation. */
function classesIn(session: TsProjectSession): FoundClass[] {
  const found: FoundClass[] = [];
  for (const sourceFile of session.compilationFiles()) {
    const visit = (node: ts.Node): void => {
      if (ts.isClassLike(node)) found.push({ node, sourceFile });
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  return found;
}

/** Class declarations a symbol resolves to, following import aliases. */
function classesOfSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): ts.ClassLikeDeclaration[] {
  if (!symbol) return [];
  // An imported base class resolves to the import specifier, not the
  // class. Left unaliased, every cross-file `extends` reads as opaque.
  return (unalias(checker, symbol).declarations ?? []).filter(ts.isClassLike);
}

/**
 * The classes an opaque heritage expression can still be tied to.
 *
 * Two independent readings, unioned because each covers what the other
 * misses. The expression's *type* is the precise one — `WithLogging(Clock)`
 * types as `{…} & typeof Clock`, so the constituent symbols name the
 * mixed-in class — and the identifiers it mentions are the fallback for
 * a factory whose return type the checker widens past recognition.
 */
function reachableClasses(checker: ts.TypeChecker, expression: ts.Expression): ts.ClassLikeDeclaration[] {
  const found = new Set<ts.ClassLikeDeclaration>();
  const type = checker.getTypeAtLocation(expression);
  const constituents = type.isIntersection() || type.isUnion() ? type.types : [type];
  for (const constituent of constituents) {
    for (const declaration of classesOfSymbol(checker, constituent.getSymbol())) {
      found.add(declaration);
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      for (const declaration of classesOfSymbol(checker, checker.getSymbolAtLocation(node))) {
        found.add(declaration);
      }
    }
    node.forEachChild(visit);
  };
  visit(expression);
  return [...found];
}

/** The inheritance edges of the whole compilation, both directions. */
function readHeritage(session: TsProjectSession, classes: readonly FoundClass[]): Heritage {
  const checker = session.checker();
  const parents = new Map<ts.ClassLikeDeclaration, ts.ClassLikeDeclaration[]>();
  const opaque: OpaqueClause[] = [];

  for (const { node } of classes) {
    for (const clause of node.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const type of clause.types) {
        const symbol = checker.getSymbolAtLocation(type.expression);
        const resolved = classesOfSymbol(checker, symbol);
        if (resolved.length > 0) {
          parents.set(node, [...(parents.get(node) ?? []), ...resolved]);
          continue;
        }
        // A named base the checker understands but that is not a class
        // in this project — `extends Error`, which lib.d.ts declares as
        // an interface plus a var of constructor type — is resolved,
        // not opaque. It simply cannot be a subclass of anything here.
        // Treating it as unenumerable let one custom Error subclass
        // refuse a push on every unrelated class in the project.
        if (symbol && (unalias(checker, symbol).declarations ?? []).length > 0) continue;
        opaque.push({
          text: `${containerName(node)} extends ${type.expression.getText()}`,
          bases: reachableClasses(checker, type.expression),
          template: Boolean(
            checker.getTypeAtLocation(type.expression).flags & ts.TypeFlags.TypeParameter,
          ),
        });
      }
    }
  }
  return { parents, opaque };
}

/** Every class whose heritage reaches `base`, transitively. */
function descendantsOf(
  base: ts.ClassLikeDeclaration,
  classes: readonly FoundClass[],
  heritage: Heritage,
): Set<ts.ClassLikeDeclaration> {
  const found = new Set<ts.ClassLikeDeclaration>();
  const reaches = (node: ts.ClassLikeDeclaration, seen: Set<ts.ClassLikeDeclaration>): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    for (const parent of heritage.parents.get(node) ?? []) {
      if (parent === base || reaches(parent, seen)) return true;
    }
    return false;
  };
  for (const { node } of classes) {
    if (node !== base && reaches(node, new Set())) found.add(node);
  }
  return found;
}

/**
 * The direct subclass of `base` on the path up from `node` — the class
 * a copy has to land in for `node`'s code to keep resolving the member
 * by inheritance.
 */
function childOfBase(
  node: ts.ClassLikeDeclaration,
  base: ts.ClassLikeDeclaration,
  heritage: Heritage,
  seen = new Set<ts.ClassLikeDeclaration>(),
): ts.ClassLikeDeclaration | undefined {
  if (seen.has(node)) return undefined;
  seen.add(node);
  for (const parent of heritage.parents.get(node) ?? []) {
    if (parent === base) return node;
    const found = childOfBase(parent, base, heritage, seen);
    if (found) return found;
  }
  return undefined;
}

function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isClassLike(current)) return current;
  }
  return undefined;
}

/**
 * Whole-line spans that remove `nodes` — their own lines, their leading
 * comments, and the blank line that separated each from what came
 * before.
 *
 * Taking the *preceding* blank rather than the following one keeps the
 * last member of a class from leaving an empty line above the closing
 * brace. A member that opens the class body has no preceding blank to
 * take, and keeping the following one would open the body with an empty
 * line, so those extend forward instead — bounded by the next span, so
 * two removals can never overlap. `applyTextEdits` rejects overlapping
 * edits, and pushing several members down removes several at once.
 */
function removalSpans(sourceFile: ts.SourceFile, nodes: readonly ts.Node[]): Span[] {
  const text = sourceFile.getFullText();
  const lineStartAt = (offset: number): number => {
    let at = offset;
    while (at > 0 && text[at - 1] !== '\n') at--;
    return at;
  };

  const raw = nodes
    .map((node) => {
      let start = lineStartAt(node.getStart(sourceFile, true));
      while (start > 0) {
        const previous = lineStartAt(start - 1);
        if (text.slice(previous, start).trim() !== '') break;
        start = previous;
      }
      let end = node.getEnd();
      while (end < text.length && text[end] !== '\n') end++;
      if (end < text.length) end++;
      return { start, end };
    })
    .sort((a, b) => a.start - b.start);

  const merged: Span[] = [];
  for (const span of raw) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  for (const [index, span] of merged.entries()) {
    if (!text.slice(0, span.start).trimEnd().endsWith('{')) continue;
    const limit = merged[index + 1]?.start ?? text.length;
    for (;;) {
      const lineEnd = text.indexOf('\n', span.end);
      if (lineEnd === -1 || lineEnd + 1 > limit) break;
      if (text.slice(span.end, lineEnd).trim() !== '') break;
      span.end = lineEnd + 1;
    }
  }
  return merged;
}

/** Whether a node contains a template literal spanning several lines. */
function hasMultilineTemplate(node: ts.Node): boolean {
  const sourceFile = node.getSourceFile();
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

/** How a request is written as a specifier, aliased where it must be. */
function specifierText(request: ImportRequest): string {
  return request.propertyName && request.propertyName !== request.name
    ? `${request.propertyName} as ${request.name}`
    : request.name;
}

/**
 * Statement text for a group of requests that share a module, a form
 * and a type-onlyness — so two names taken from one module arrive as
 * one statement rather than two.
 */
function importStatement(
  session: TsProjectSession,
  fromFile: string,
  group: readonly ImportRequest[],
): string {
  const request = group[0]!;
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
  const clause =
    request.form === 'namespace'
      ? `* as ${request.name}`
      : request.form === 'default'
        ? request.name
        : `{ ${group.map(specifierText).join(', ')} }`;
  return `import ${request.typeOnly ? 'type ' : ''}${clause} from ${quote}${specifier}${quote};`;
}

/**
 * Edits that bind `requests` in `file`.
 *
 * A name folds into an existing named import from the same module where
 * there is one, so a file never grows a second import statement for a
 * module it already imports; the rest go in one block after the last
 * import.
 */
function importEdits(
  session: TsProjectSession,
  file: string,
  requests: readonly ImportRequest[],
): TextEdit[] {
  const sourceFile = session.program().getSourceFile(file);
  if (!sourceFile || requests.length === 0) return [];
  const at = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset);
  const options = session.program().getCompilerOptions();
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const edits: TextEdit[] = [];
  const fresh: ImportRequest[] = [];

  for (const request of requests) {
    const target = request.origin.kind === 'file' ? request.origin.file : undefined;
    let anchor: { last: ts.ImportSpecifier; typePrefix: boolean } | undefined;
    if (request.form === 'named' && target !== undefined) {
      for (const declaration of imports) {
        const clause = declaration.importClause;
        const bindings = clause?.namedBindings;
        if (!clause || !bindings || !ts.isNamedImports(bindings)) continue;
        if (resolvedModuleOf(declaration, options) !== target) continue;
        // `import type { A }` cannot carry a value binding, and a
        // per-specifier `type` modifier covers the other direction.
        if (clause.isTypeOnly && !request.typeOnly) continue;
        const last = bindings.elements[bindings.elements.length - 1];
        if (!last) continue;
        anchor = { last, typePrefix: request.typeOnly && !clause.isTypeOnly };
        break;
      }
    }
    if (!anchor) {
      fresh.push(request);
      continue;
    }
    edits.push({
      range: { start: at(anchor.last.getEnd()), end: at(anchor.last.getEnd()) },
      newText: `, ${anchor.typePrefix ? 'type ' : ''}${specifierText(request)}`,
    });
  }

  if (fresh.length > 0) {
    // Names from one module become one statement: a file that grows two
    // imports of the same specifier is what organize-imports exists to
    // undo, and here it would be this tool's own doing.
    const groups = new Map<string, ImportRequest[]>();
    for (const request of fresh) {
      const module =
        request.origin.kind === 'file' ? request.origin.file : `pkg:${request.origin.text}`;
      const key =
        request.form === 'named'
          ? `named:${request.typeOnly}:${module}`
          : `${request.form}:${request.name}:${module}`;
      groups.set(key, [...(groups.get(key) ?? []), request]);
    }
    const text = [...groups.values()]
      .map((group) => importStatement(session, file, group))
      .join('\n');
    const last = imports[imports.length - 1];
    if (last) {
      edits.push({ range: { start: at(last.getEnd()), end: at(last.getEnd()) }, newText: `\n${text}` });
    } else {
      const first = sourceFile.statements[0];
      const start = first ? first.getStart(sourceFile, true) : 0;
      edits.push({ range: { start: at(start), end: at(start) }, newText: `${text}\n\n` });
    }
  }
  return edits;
}

/**
 * Import specifiers in `file` that nothing refers to once `dead` is
 * gone.
 *
 * Not tidiness: under `noUnusedLocals` the import a departing member
 * orphans is TS6133, which the guard reports as a diagnostic the edit
 * introduced and refuses the whole push over.
 */
function orphanedImportEdits(
  session: TsProjectSession,
  sourceFile: ts.SourceFile,
  dead: ReadonlySet<ts.Node>,
): TextEdit[] {
  const checker = session.checker();
  const live = new Set<ts.Symbol>();
  // `export { A }` with no module specifier refers to the local binding
  // through a symbol of its own, so it is matched by name instead.
  const reExported = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier === undefined) {
      const clause = node.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) reExported.add((element.propertyName ?? element.name).text);
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
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!clause || !bindings || !ts.isNamedImports(bindings)) continue;
    const orphans = bindings.elements.filter((element) => {
      const symbol = checker.getSymbolAtLocation(element.name);
      return symbol !== undefined && !live.has(symbol) && !reExported.has(element.name.text);
    });
    if (orphans.length === 0) continue;

    // One name: the shared unbinder knows every shape it can take,
    // including the one where removing it removes the statement.
    if (orphans.length === 1) {
      const edit = removeBinding(orphans[0]!.name, sourceFile);
      if (edit) edits.push(edit);
      continue;
    }
    // Several: one edit per name would overlap at the comma between
    // them, so the clause is rewritten whole.
    const survivors = bindings.elements.filter((element) => !orphans.includes(element));
    if (survivors.length > 0) {
      edits.push({
        range: { start: at(bindings.getStart(sourceFile)), end: at(bindings.getEnd()) },
        newText: `{ ${survivors.map((element) => element.getText(sourceFile)).join(', ')} }`,
      });
      continue;
    }
    if (clause.name) {
      edits.push({ range: { start: at(clause.name.getEnd()), end: at(bindings.getEnd()) }, newText: '' });
      continue;
    }
    const edit = removeBinding(orphans[0]!.name, sourceFile);
    if (edit) edits.push(edit);
  }
  return edits;
}

/**
 * Imports a destination needs so the copied members still mean what
 * they meant on the base.
 *
 * Every free name in the copied text is re-resolved against the
 * destination's scope. One already bound there to the same binding
 * needs nothing; one bound there to a *different* binding is a refusal,
 * because that is the failure the guard cannot see — the copy compiles
 * and computes something else. Everything left is written from the
 * binding the base's file used, so a package specifier survives as
 * itself and a relative one is re-based.
 */
function dependencyImports(
  session: TsProjectSession,
  options: {
    members: readonly ts.ClassElement[];
    inMembers: (node: ts.Node) => boolean;
    destinationFile: string;
    /** Node the destination's scope is read at. */
    scopeNode: ts.Node;
    /** How refusal messages name the destination. */
    where: string;
  },
): ImportRequest[] {
  const { members, inMembers, destinationFile, scopeNode, where } = options;
  const checker = session.checker();
  const scope = scopeAt(checker, scopeNode);
  const requests: ImportRequest[] = [];

  for (const member of members) {
    for (const node of referencesIn(member)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol) continue;
      const declarations = symbol.declarations ?? [];
      // A name the copied text declares travels with it.
      if (declarations.length > 0 && declarations.every(inMembers)) continue;
      const resolved = unalias(checker, symbol);
      // A global is declared in a script rather than a module, so there
      // is no module to import it from.
      if (!(resolved.declarations ?? []).some((home) => ts.isExternalModule(home.getSourceFile()))) {
        continue;
      }

      const there = scope.get(node.text);
      if (there !== undefined) {
        // Identity is not enough: an exported declaration referenced
        // from its own file has one symbol from getSymbolAtLocation and
        // a different one from getSymbolsInScope.
        if (!sameBinding(checker, there, symbol)) {
          throw new Error(
            `"${node.text}" already means something else in ${destinationFile}, so the copy in ` +
              `${where} would compile and compute something different. Rename one of them first.`,
          );
        }
        continue;
      }
      if (declarations.some((home) => fileOf(home) === destinationFile)) continue;

      const typeOnly = (resolved.flags & ts.SymbolFlags.Value) === 0;
      const binding = declarations[0];
      const originOf = (statement: ts.ImportDeclaration): ImportOrigin => {
        const origin = resolvedModuleOf(statement, session.program().getCompilerOptions());
        return origin === undefined
          ? { kind: 'package', text: (statement.moduleSpecifier as ts.StringLiteral).text }
          : { kind: 'file', file: origin };
      };

      if (binding && ts.isImportSpecifier(binding) && ts.isImportDeclaration(binding.parent.parent.parent)) {
        const statement = binding.parent.parent.parent;
        requests.push({
          name: node.text,
          origin: originOf(statement),
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
            origin: originOf(statement),
            form: ts.isNamespaceImport(binding) ? 'namespace' : 'default',
            typeOnly,
          });
          continue;
        }
      }

      // A declaration in the base's own file: the destination can only
      // name it if that file exports it.
      const home = binding?.getSourceFile();
      if (!home) continue;
      const moduleSymbol = checker.getSymbolAtLocation(home);
      const exported =
        moduleSymbol !== undefined &&
        checker.getExportsOfModule(moduleSymbol).some((candidate) => candidate.name === node.text);
      if (!exported) {
        throw new Error(
          `The members read "${node.text}", which ${path.resolve(home.fileName)} does not export, ` +
            `so ${destinationFile} cannot name it. Export it and run again.`,
        );
      }
      requests.push({
        name: node.text,
        origin: { kind: 'file', file: path.resolve(home.fileName) },
        form: 'named',
        typeOnly,
      });
    }
  }
  return requests;
}

export const pushMembersDown: Tool<
  PushMembersDownInput,
  PushMembersDownOutput,
  TsProjectSession
> = {
  name: 'ts/refactors/push-members-down',
  description:
    'Copies members off a base class into the subclasses that use them and deletes them from ' +
    "the base — ReSharper's Push Members Down. The receiving set is not knowable from the base: " +
    'ts.Program indexes inheritance upward only, so this scans every heritage clause in the ' +
    'compilation and resolves each extends through the checker. Target the base class by name ' +
    '(symbol) or exact position, name the members to push, and optionally narrow the receiving ' +
    'subclasses with to; the default is every subclass, each of which must actually use every ' +
    'member. Each copy gets the imports its body depends on in that subclass\'s file, and the ' +
    'imports the base file no longer needs are removed. Refuses a member a receiving subclass ' +
    'does not use (that is pure duplication — narrow with to), a member the base\'s own code ' +
    'calls, an abstract member, a static member (that is ts/refactors/move-member), a member a ' +
    'subclass already declares or a base class also declares, a reference reached through a ' +
    'base-typed value or a string key, and a hierarchy the checker cannot close — a mixin base ' +
    '(class X extends WithLogging(Base)) resolves to a call expression, so the subclass set ' +
    'would be incomplete. Copying into N subclasses duplicates code by construction, which is ' +
    'reported in warnings. Dry-run by default; apply: true writes to disk unless the typecheck ' +
    'reports newDiagnostics.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      symbol: { type: 'string', description: 'Base class to push members off' },
      members: {
        type: 'array',
        items: { type: 'string' },
        description: 'Member names to push down',
      },
      to: {
        type: 'array',
        items: { type: 'string' },
        description: 'Subclasses to receive the members (default: every subclass of the base)',
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    required: ['members'],
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      targets: {
        type: 'array',
        description: 'Subclasses the members were copied into',
        items: {
          type: 'object',
          properties: { container: { type: 'string' }, file: { type: 'string' } },
          required: ['container', 'file'],
        },
      },
      members: { type: 'array', items: { type: 'string' } },
    },
    ['targets', 'members'],
  ),

  async run(session, input) {
    if (!Array.isArray(input.members) || input.members.length === 0) {
      throw new Error('members must name at least one member of the base class');
    }
    const checker = session.checker();
    const warnings: string[] = [];

    const declaration = declarationAt(resolveTarget(session, input));
    if (!ts.isClassDeclaration(declaration)) {
      throw new Error(
        `Push Members Down targets a base class; the declaration here is a ` +
          `${ts.SyntaxKind[declaration.kind]}`,
      );
    }
    const base = declaration;
    const baseName = containerName(base);
    const baseSource = base.getSourceFile();
    const baseFile = path.resolve(baseSource.fileName);
    if (baseSource.isDeclarationFile) {
      throw new Error(`${baseName} is declared in a .d.ts file, which this tool does not rewrite`);
    }

    // The subclass set, built by scanning the compilation because
    // nothing indexes it.
    const classes = classesIn(session);
    const heritage = readHeritage(session, classes);
    const descendants = descendantsOf(base, classes, heritage);

    // Whether the scan closed comes first, and before the count of what
    // it found: "nothing extends this" is a false statement rather than
    // a merely unhelpful one when an edge could not be followed.
    const unresolved = new Set<string>();
    for (const clause of heritage.opaque) {
      if (clause.template) continue;
      const reaches =
        clause.bases.length === 0 ||
        clause.bases.some((candidate) => candidate === base || descendants.has(candidate));
      if (reaches) unresolved.add(clause.text);
    }
    const refuseUnresolved = (): never => {
      throw new Error(
        `${baseName}'s subclasses cannot be enumerated: ${[...unresolved].join(', ')} resolves to ` +
          'no class, so a subclass of it could be invisible here. Pushing members into a set ' +
          'known to be incomplete would silently strip them from whatever it missed.',
      );
    };
    if (unresolved.size > 0) refuseUnresolved();

    const subclasses = classes
      .map(({ node }) => node)
      .filter((node) => (heritage.parents.get(node) ?? []).includes(base));
    if (subclasses.length === 0) {
      throw new Error(
        `Nothing in this project extends ${baseName}, so there is nowhere to push a member down ` +
          'to. Moving a member out of a class with no subclasses is ts/refactors/move-member.',
      );
    }
    const anonymous = subclasses.filter((node) => !ts.isClassDeclaration(node) || !node.name);
    if (anonymous.length > 0) {
      throw new Error(
        `${baseName} is extended by an anonymous class at ${locate(anonymous[0]!)}, which no copy ` +
          'can be addressed to',
      );
    }

    // The members, with every declaration of each: an overload set and
    // a get/set pair are one member spelled several times, and leaving
    // one behind would leave the base half-declaring it.
    const available = new Set<string>();
    for (const member of base.members) {
      if (member.name && (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name))) {
        available.add(member.name.text);
      }
    }
    const pushed: ts.ClassElement[] = [];
    const memberNames: string[] = [];
    // Deduplicated: a name given twice would be copied twice, which the
    // guard reports as a duplicate identifier rather than as the input
    // mistake it is.
    for (const name of new Set(input.members)) {
      const found = base.members.filter(
        (member) =>
          member.name !== undefined &&
          (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name)) &&
          member.name.text === name,
      );
      if (found.length === 0) {
        throw new Error(
          `${baseName} declares no member named "${name}". It declares: ` +
            `${[...available].join(', ')}. An inherited member is not one of ${baseName}'s to ` +
            'push down — target the class that declares it.',
        );
      }
      pushed.push(...found);
    }
    pushed.sort((a, b) => a.getStart(baseSource, true) - b.getStart(baseSource, true));
    for (const member of pushed) {
      const name = (member.name as ts.Identifier | ts.PrivateIdentifier).text;
      if (!memberNames.includes(name)) memberNames.push(name);
    }

    // Shape refusals, before anything else: they are properties of the
    // declaration alone, and their messages are the most actionable.
    for (const member of pushed) {
      const name = (member.name as ts.Identifier | ts.PrivateIdentifier).text;
      const where = `${baseName}.${name}`;
      const flags = ts.getCombinedModifierFlags(member);
      if (ts.isPrivateIdentifier(member.name!)) {
        throw new Error(
          `${where} is a #private member. It is unreachable outside ${baseName}'s own body, so no ` +
            'subclass can be using it and a copy would be dead code in each one.',
        );
      }
      if (flags & ts.ModifierFlags.Static) {
        throw new Error(
          `${where} is static. A static is reached through the class object rather than ` +
            'inherited through an instance, so moving one is ts/refactors/move-member.',
        );
      }
      if (flags & ts.ModifierFlags.Abstract) {
        throw new Error(
          `${where} is abstract: it has no body, and the declaration *is* the contract the ` +
            'subclasses implement. Pushing it down would delete that contract rather than move it.',
        );
      }
      if (flags & ts.ModifierFlags.Private) {
        throw new Error(
          `${where} is private, so no subclass can reach it — a copy would be dead code in each ` +
            'one. Make it protected first if the subclasses are meant to use it.',
        );
      }
      if (
        (ts.isMethodDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member)) &&
        member.body === undefined
      ) {
        throw new Error(`${where} has no body, so there is nothing to copy down`);
      }
      // `super.x` in a pushed member means the base's *own* base today
      // and would mean the base itself in a subclass — a different
      // method, silently, whenever both declare the name.
      let readsSuper = false;
      const findSuper = (node: ts.Node): void => {
        if (readsSuper) return;
        if (node.kind === ts.SyntaxKind.SuperKeyword) {
          readsSuper = true;
          return;
        }
        node.forEachChild(findSuper);
      };
      findSuper(member);
      if (readsSuper) {
        throw new Error(
          `${where} reads \`super\`, which means ${baseName}'s own base here and would mean ` +
            `${baseName} once the member sits on a subclass`,
        );
      }
      if (ts.canHaveDecorators(member) && (ts.getDecorators(member) ?? []).length > 0) {
        warnings.push(
          `${where} is decorated, and each copy carries the decorator — so it runs once per ` +
            'subclass instead of once.',
        );
      }
    }

    // Hierarchy refusals. memberHierarchy's own `unresolved` is merged
    // into the scan's: it reports an unfollowable edge only where one
    // could hide a declaration of *this member*, which is a narrower
    // question than whether one could hide a subclass — a mixin whose
    // product declares nothing by that name is silent there.
    for (const member of pushed) {
      const name = (member.name as ts.Identifier).text;
      const hierarchy = memberHierarchy(session, member);
      for (const entry of hierarchy.unresolved) unresolved.add(entry);
      if (hierarchy.supertypes.length > 0) {
        const others = hierarchy.supertypes
          .map((other) => `${other.container} (${other.file}:${other.line + 1})`)
          .join(', ');
        throw new Error(
          `${baseName}.${name} overrides the declaration on ${others}. Removing it from ` +
            `${baseName} would not remove the member — ${baseName} would inherit the other ` +
            'implementation, silently, everywhere it is still used.',
        );
      }
      const alreadyDeclares = hierarchy.subtypes.filter((other) => other.container !== baseName);
      if (alreadyDeclares.length > 0) {
        const others = alreadyDeclares
          .map((other) => `${other.container} (${other.file}:${other.line + 1})`)
          .join(', ');
        throw new Error(
          `${others} already declares "${name}". A copy would replace an override that exists ` +
            'because it is different from the base version.',
        );
      }
    }
    if (unresolved.size > 0) refuseUnresolved();

    // References, attributed to the subclass whose copy has to serve
    // each one.
    const pushedSpans = pushed.map((member) => ({
      file: baseFile,
      start: member.getStart(baseSource, true),
      end: member.getEnd(),
    }));
    const inMembers = (node: ts.Node): boolean => {
      const file = fileOf(node);
      const start = node.getStart(node.getSourceFile());
      return pushedSpans.some(
        (span) => span.file === file && start >= span.start && start < span.end,
      );
    };

    /** Members each subclass uses, by the class that must receive them. */
    const usedBy = new Map<ts.ClassLikeDeclaration, Set<string>>();
    /** Members referenced from inside the copied text, so every copy uses them. */
    const usedByEveryCopy = new Set<string>();
    const use = (subclass: ts.ClassLikeDeclaration, name: string): void => {
      const set = usedBy.get(subclass) ?? new Set<string>();
      set.add(name);
      usedBy.set(subclass, set);
    };

    for (const member of pushed) {
      const name = (member.name as ts.Identifier).text;
      const where = `${baseName}.${name}`;
      const references = classifyReferences(
        session,
        baseFile,
        member.name!.getStart(baseSource),
      ).filter(isUse);

      for (const reference of references) {
        if (inMembers(reference.node)) {
          // The reference travels with the copy, so every copy uses it.
          usedByEveryCopy.add(name);
          continue;
        }
        const site = locate(reference.node);
        const owner = enclosingClass(reference.node);
        if (owner === base) {
          throw new Error(
            `${where} is used by ${baseName}'s own code at ${site}. Pushing it down would leave ` +
              'that call with nothing to resolve to — push the member that calls it down too, ' +
              'or leave this one where it is.',
          );
        }
        if (ts.isStringLiteralLike(reference.node)) {
          throw new Error(
            `${where} is reached through a string key at ${site}. Nothing about which subclass ` +
              'that access lands on is decidable here, and a computed key would not even be ' +
              'reported.',
          );
        }
        const access = reference.node.parent;
        if (!access || !ts.isPropertyAccessExpression(access) || access.name !== reference.node) {
          throw new Error(
            `${where} is used at ${site} in a way this cannot attribute to a subclass ` +
              `(\`${(reference.node.parent ?? reference.node).getText().slice(0, 60).replace(/\s+/g, ' ')}\`)`,
          );
        }

        const receiver = access.expression;
        const holder =
          receiver.kind === ts.SyntaxKind.ThisKeyword || receiver.kind === ts.SyntaxKind.SuperKeyword
            ? owner
            : classesOfSymbol(checker, checker.getTypeAtLocation(receiver).getSymbol())[0];
        if (holder === base) {
          throw new Error(
            `${where} is read off a ${baseName}-typed value at ${site}. Every subclass copy would ` +
              `miss it: the declared type is ${baseName}, which is exactly what stops having the ` +
              'member.',
          );
        }
        const receivingClass = holder ? childOfBase(holder, base, heritage) : undefined;
        if (!receivingClass) {
          throw new Error(
            `${where} is used at ${site} through ${holder ? containerName(holder) : 'a value'}, ` +
              `which this scan does not see as a subclass of ${baseName}`,
          );
        }
        use(receivingClass, name);
      }
    }

    // The receiving set.
    const byName = new Map<string, ts.ClassLikeDeclaration>();
    for (const subclass of subclasses) byName.set(containerName(subclass), subclass);
    let targets: ts.ClassLikeDeclaration[];
    if (input.to !== undefined) {
      if (input.to.length === 0) throw new Error('to selected no subclass to push into');
      const missing = input.to.filter((name) => !byName.has(name));
      if (missing.length > 0) {
        throw new Error(
          `${missing.map((name) => `"${name}"`).join(', ')} ${missing.length === 1 ? 'does' : 'do'}` +
            ` not extend ${baseName}. Its subclasses are: ${[...byName.keys()].join(', ')}.`,
        );
      }
      targets = [...new Set(input.to)].map((name) => byName.get(name)!);
    } else {
      targets = subclasses;
    }
    const receiving = new Set(targets);

    for (const name of memberNames) {
      if (usedByEveryCopy.has(name)) continue;
      for (const subclass of targets) {
        if (usedBy.get(subclass)?.has(name)) continue;
        const users = [...usedBy.entries()]
          .filter(([, names]) => names.has(name))
          .map(([node]) => containerName(node));
        throw new Error(
          `${containerName(subclass)} does not use ${baseName}.${name}, so pushing it there would ` +
            'be pure duplication rather than a move. ' +
            (users.length > 0
              ? `Narrow with to: ${JSON.stringify(users)}.`
              : `Nothing that extends ${baseName} uses it — ts/refactors/safe-delete is the tool ` +
                'for a member nobody calls.'),
        );
      }
    }
    for (const [subclass, names] of usedBy) {
      if (receiving.has(subclass)) continue;
      const lost = memberNames.filter((name) => names.has(name));
      if (lost.length === 0) continue;
      throw new Error(
        `${containerName(subclass)} uses ${lost.map((name) => `${baseName}.${name}`).join(', ')} ` +
          'but is not in to, so it would lose the member the moment the base stopped declaring it',
      );
    }

    // The copied text, once, indented for a class body.
    const indentSize = formatSettings(session).indentSize ?? 2;
    const multiline = pushed.some(hasMultilineTemplate);
    if (multiline) {
      warnings.push(
        'A pushed member contains a multi-line template literal, whose indentation is string ' +
          'content rather than layout, so the copies keep the original indentation.',
      );
    }
    const memberText = (indent: string): string =>
      pushed
        .map((member) => {
          const text = baseSource.text.slice(member.getStart(baseSource, true), member.getEnd());
          return multiline ? text : reindent(text, columnOf(member), indent);
        })
        .join('\n\n');

    // Edits.
    const changes: Record<string, TextEdit[]> = {};
    const add = (file: string, edit: TextEdit): void => {
      changes[file] = [...(changes[file] ?? []), edit];
    };

    for (const subclass of targets) {
      const destinationSource = subclass.getSourceFile();
      const destinationFile = path.resolve(destinationSource.fileName);
      const at = (offset: number) => destinationSource.getLineAndCharacterOfPosition(offset);
      const first = subclass.members[0];
      const indent = ' '.repeat(first ? columnOf(first) : columnOf(subclass) + indentSize);
      const text = memberText(indent);
      const last = subclass.members[subclass.members.length - 1];
      const offset = last ? last.getEnd() : subclass.members.end;
      add(destinationFile, {
        range: { start: at(offset), end: at(offset) },
        newText: last ? `\n\n${text}` : `\n${text}\n`,
      });

      // One request per name, however many members depend on it, and
      // one pass over the file: two passes would each write their own
      // import statement for the same module.
      const requests: ImportRequest[] = [];
      for (const request of dependencyImports(session, {
        members: pushed,
        inMembers,
        destinationFile,
        scopeNode: subclass,
        where: containerName(subclass),
      })) {
        if (!requests.some((other) => other.name === request.name)) requests.push(request);
      }
      for (const importEdit of importEdits(session, destinationFile, requests)) {
        add(destinationFile, importEdit);
      }
    }

    // The removal, and the imports it orphans in the base's file.
    for (const span of removalSpans(baseSource, pushed)) {
      add(baseFile, {
        range: {
          start: baseSource.getLineAndCharacterOfPosition(span.start),
          end: baseSource.getLineAndCharacterOfPosition(span.end),
        },
        newText: '',
      });
    }
    const dead = new Set<ts.Node>();
    // Only when the copies leave this file. A subclass declared beside
    // its base keeps the names in place, and the copied text is raw
    // source the pruning pass cannot see, so counting its names as gone
    // would drop an import the copy still needs.
    if (!targets.some((subclass) => fileOf(subclass) === baseFile)) {
      for (const member of pushed) for (const node of referencesIn(member)) dead.add(node);
    }
    for (const edit of orphanedImportEdits(session, baseSource, dead)) add(baseFile, edit);

    if (targets.length > 1) {
      warnings.push(
        `${memberNames.join(', ')} now ${memberNames.length === 1 ? 'exists' : 'exist'} in ` +
          `${targets.length} places (${targets.map(containerName).join(', ')}) rather than one. ` +
          'That duplication is what this refactoring does; nothing keeps the copies in step, and ' +
          'a later fix to one is not a fix to the others.',
      );
    }

    const edit: WorkspaceEdit = { changes };
    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output = {
      edit,
      filesChanged,
      newDiagnostics,
      warnings,
      members: memberNames,
      targets: targets
        .map((subclass) => ({ container: containerName(subclass), file: fileOf(subclass) }))
        .sort((a, b) => a.container.localeCompare(b.container)),
    };

    if (input.apply !== true || newDiagnostics.length > 0) return { applied: false, ...output };
    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return { applied: true, ...output };
  },
};
