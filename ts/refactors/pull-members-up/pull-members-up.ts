import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { memberHierarchy } from '../../ast/hierarchy.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { relativeSpecifier, resolvedModuleOf, scopeAt, wholeLineSpanOf } from '../imports.js';
import { reindent } from '../layout.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { formatSettings, userPreferences } from '../refactor-action.js';
import { unalias } from '../substitution.js';

/**
 * Moves members from a derived class up into a type it inherits from —
 * ReSharper's Pull Members Up.
 *
 * **The destination decides whether anything moves at all.** In C# the
 * targets are a base class and an interface, and both take the member:
 * an interface member is a signature, and the implementation stays put
 * either way because C# interfaces (before default members) hold none.
 * TypeScript keeps that split and sharpens it. A base *class* takes the
 * whole member — declaration, body, and the imports its body needs. An
 * *interface* cannot take a body, so only the signature goes up and the
 * implementation stays exactly where it was. That is not a lesser form
 * of the same edit; it is a different edit, and the tool refuses to
 * perform it unless it was asked for by name (`asAbstract`), because a
 * caller who wanted a move and got a copy has a duplicated declaration
 * they did not ask for.
 *
 * Removing the member from the class is not optional in that case
 * either: `class C implements I` is checked against `I`, so a class that
 * stops declaring a member it implements is `TS2420`. The signature form
 * therefore always leaves the class alone.
 *
 * **Nothing outside the two types changes.** This is the cheapest member
 * move in the family: inheritance preserves every call site, so
 * `circle.reach(0, 0)` resolves to the pulled-up declaration with no
 * edit at the call at all. What replaces the reference rewrite is a set
 * of preconditions about *state*, and they are where the value is. A
 * member that reads `private` state staying behind cannot compile in its
 * new home; a member that reads `this.radius` when the base has no
 * `radius` cannot either. Both are refused before an edit exists, with
 * the name of what would strand it, rather than left to a `TS2339` the
 * caller has to reverse-engineer.
 *
 * **Siblings are reported rather than touched.** Another subclass of the
 * same base may declare its own version of the member. Pulling this one
 * up leaves that one alone, which is correct — deleting it would change
 * which body runs for that subclass. But the pulled-up member is then
 * dead for that sibling, and that is the sort of fact a caller has to be
 * told rather than discover. `memberHierarchy` finds them; `siblings`
 * reports them and a warning says what it means.
 */

export interface PullMembersUpInput {
  /** Derived class to pull members out of, by name. */
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  /** Members to pull up, by name. */
  members: string[];
  /** Destination supertype, when the class has more than one. */
  to?: string;
  /** Leave a signature on the destination and the body where it is. */
  asAbstract?: boolean;
  apply?: boolean;
}

/** Another subtype of the destination that declares the same member. */
export interface SiblingDeclaration {
  /** Class or interface declaring its own version. */
  container: string;
  file: string;
  line: number;
}

export interface PullMembersUpOutput extends RefactorOutput {
  /** Member names pulled up, in the order they are declared. */
  members: string[];
  /** Subtypes of the destination that keep their own declaration. */
  siblings: SiblingDeclaration[];
}

type Container = ts.ClassLikeDeclaration | ts.InterfaceDeclaration;

type PullableMember =
  | ts.MethodDeclaration
  | ts.PropertyDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

/** One member name, with every declaration the class gives it. */
interface MemberGroup {
  name: string;
  declarations: PullableMember[];
}

/** A supertype named by one heritage clause entry. */
interface Supertype {
  node: Container;
  kind: 'extends' | 'implements';
  name: string;
}

/** Where an import has to come from, as the destination must write it. */
type ImportOrigin = { kind: 'file'; file: string } | { kind: 'package'; text: string };

interface ImportRequest {
  name: string;
  origin: ImportOrigin;
  propertyName?: string;
  typeOnly: boolean;
}

const IDENTIFIER_MEMBER_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

function isContainer(node: ts.Node): node is Container {
  return ts.isClassLike(node) || ts.isInterfaceDeclaration(node);
}

function isPullable(member: ts.ClassElement): member is PullableMember {
  return IDENTIFIER_MEMBER_KINDS.has(member.kind);
}

function nameOf(container: Container): string {
  return container.name?.text ?? '(anonymous)';
}

function columnOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, true)).character;
}

function locationOf(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${path.resolve(sourceFile.fileName)}:${line + 1}:${character + 1}`;
}

/** The JSDoc block immediately above a node, verbatim. */
function jsDocOf(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
  for (let index = ranges.length - 1; index >= 0; index--) {
    const range = ranges[index]!;
    if (sourceFile.text.slice(range.pos, range.pos + 3) === '/**') {
      return sourceFile.text.slice(range.pos, range.end);
    }
  }
  return undefined;
}

/**
 * An identifier that refers to something rather than naming it — the
 * set whose meaning the surrounding scope decides, and so the set that
 * has to still resolve in the destination's file.
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

/** Every identifier under `roots` that refers to something. */
function referencesUnder(roots: readonly ts.Node[]): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isReference(node)) found.push(node);
    node.forEachChild(visit);
  };
  for (const root of roots) visit(root);
  return found;
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

interface Span {
  start: number;
  end: number;
}

/**
 * Whole-line spans that remove `nodes` — their own lines, their leading
 * comments, and the blank line that separated each from what came
 * before.
 *
 * Taking the *preceding* blank rather than the following one keeps the
 * last member of a class from leaving an empty line above the closing
 * brace. A member that opens the class body has no preceding blank to
 * take and keeping the following one would open the body with an empty
 * line, so those extend forward instead, bounded by the next span. That
 * bound is load-bearing: `applyTextEdits` rejects overlapping edits, and
 * pulling up two adjacent members is the ordinary case here.
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

/**
 * The declarations a heritage clause names, resolved through the
 * checker. An imported base resolves to its import specifier, so the
 * alias is followed — otherwise every cross-file `extends` reads as
 * un-analyzable.
 */
function heritageOf(
  container: Container,
  checker: ts.TypeChecker,
): { supertypes: Supertype[]; unresolved: string[] } {
  const supertypes: Supertype[] = [];
  const unresolved: string[] = [];
  for (const clause of container.heritageClauses ?? []) {
    const kind = clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
    for (const type of clause.types) {
      let symbol = checker.getSymbolAtLocation(type.expression);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declarations = symbol?.declarations?.filter(isContainer) ?? [];
      if (declarations.length === 0) {
        unresolved.push(`${nameOf(container)} ${kind} ${type.expression.getText()}`);
        continue;
      }
      for (const declaration of declarations) {
        supertypes.push({ node: declaration, kind, name: nameOf(declaration) });
      }
    }
  }
  return { supertypes, unresolved };
}

/** The destination plus every type it inherits from, transitively. */
function supertypeClosure(destination: Container, checker: ts.TypeChecker): Set<Container> {
  const seen = new Set<Container>();
  const queue: Container[] = [destination];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const supertype of heritageOf(current, checker).supertypes) queue.push(supertype.node);
  }
  return seen;
}

/**
 * Whether a container declares a member of this name — including one
 * declared as a constructor parameter property, which is a member of
 * the class but not a member of `members`.
 */
function declaresMemberNamed(container: Container, name: string): boolean {
  for (const member of container.members) {
    if (
      member.name &&
      (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) &&
      member.name.text === name
    ) {
      return true;
    }
    if (ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        if (
          ts.isParameterPropertyDeclaration(parameter, member) &&
          ts.isIdentifier(parameter.name) &&
          parameter.name.text === name
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/** The declaration of `name` on the class, member or parameter property. */
function ownDeclarationOf(container: Container, name: string): ts.Declaration | undefined {
  for (const member of container.members) {
    if (member.name && ts.isIdentifier(member.name) && member.name.text === name) return member;
    if (ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        if (
          ts.isParameterPropertyDeclaration(parameter, member) &&
          ts.isIdentifier(parameter.name) &&
          parameter.name.text === name
        ) {
          return parameter;
        }
      }
    }
  }
  return undefined;
}

/**
 * `memberHierarchy`, addressed by container and name rather than by a
 * declaration node.
 *
 * The set this tool needs is every subtype of the *destination* that
 * declares the member — which is exactly what `memberHierarchy`
 * computes, but only once the member lives on the destination, and that
 * is after the edit this is deciding whether to build. It reads two
 * things off the declaration it is handed, the container it hangs from
 * and the name it declares, so the query is spelled as a member
 * carrying those and nothing else. `hierarchy.ts` should grow this
 * form; until it does, the synthesized node is how to ask.
 */
function hierarchyAt(session: TsProjectSession, container: Container, name: string) {
  const query = ts.factory.createPropertyDeclaration(
    undefined,
    ts.factory.createIdentifier(name),
    undefined,
    undefined,
    undefined,
  );
  (query as { parent: ts.Node }).parent = container;
  return memberHierarchy(session, query);
}

/** Statement text for one import, in the style the project writes. */
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
  const alias =
    request.propertyName && request.propertyName !== request.name
      ? `${request.propertyName} as ${request.name}`
      : request.name;
  return `import ${request.typeOnly ? 'type ' : ''}{ ${alias} } from ${quote}${specifier}${quote};`;
}

/**
 * Edits that bind `requests` in `file`.
 *
 * A name folds into an existing named import from the same module when
 * the two agree about type-onlyness, so a file never grows a second
 * statement for a module it already imports; the rest go in one block
 * after the last import.
 */
function importEdits(
  session: TsProjectSession,
  file: string,
  requests: readonly ImportRequest[],
): TextEdit[] {
  const sourceFile = session.program().getSourceFile(file);
  if (!sourceFile || requests.length === 0) return [];

  const at = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset);
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const edits: TextEdit[] = [];
  const fresh: ImportRequest[] = [];

  for (const request of requests) {
    const target = request.origin.kind === 'file' ? request.origin.file : undefined;
    let anchor: ts.ImportSpecifier | undefined;
    if (target !== undefined) {
      for (const declaration of imports) {
        const bindings = declaration.importClause?.namedBindings;
        if (
          bindings === undefined ||
          !ts.isNamedImports(bindings) ||
          bindings.elements.length === 0 ||
          declaration.importClause?.isTypeOnly !== request.typeOnly ||
          resolvedModuleOf(declaration, session.program().getCompilerOptions()) !== target
        ) {
          continue;
        }
        anchor = bindings.elements[bindings.elements.length - 1];
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
 * Import specifiers in the file the members left that nothing refers to
 * any more.
 *
 * Not tidiness: under `noUnusedLocals` an orphaned import is `TS6133`,
 * which the guard reports as a diagnostic this edit introduced and
 * refuses the whole pull-up over.
 */
function unusedImportEdits(
  session: TsProjectSession,
  sourceFile: ts.SourceFile,
  dead: ReadonlySet<ts.Node>,
): TextEdit[] {
  const checker = session.checker();
  const live = new Set<ts.Symbol>();
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
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const orphans = bindings.elements.filter((element) => {
      const symbol = checker.getSymbolAtLocation(element.name);
      return symbol !== undefined && !live.has(symbol) && !reExported.has(element.name.text);
    });
    if (orphans.length === 0) continue;

    const survivors = bindings.elements.filter((element) => !orphans.includes(element));
    if (survivors.length > 0) {
      // One replacement of the whole clause rather than a deletion per
      // name: two deletions in the same list overlap at the comma.
      edits.push({
        range: { start: at(bindings.getStart(sourceFile)), end: at(bindings.getEnd()) },
        newText: `{ ${survivors.map((element) => element.getText(sourceFile)).join(', ')} }`,
      });
      continue;
    }
    const defaultName = statement.importClause?.name;
    if (defaultName) {
      edits.push({ range: { start: at(defaultName.getEnd()), end: at(bindings.getEnd()) }, newText: '' });
      continue;
    }
    const span = wholeLineSpanOf(statement, sourceFile);
    edits.push({ range: { start: at(span.start), end: at(span.end) }, newText: '' });
  }
  return edits;
}

/**
 * Imports the destination's file needs so the pulled-up code still
 * means what it meant.
 *
 * Every free name is re-resolved against the destination's scope. One
 * already bound there to the same symbol needs nothing; one bound there
 * to a *different* symbol is a refusal, because that is the failure the
 * guard cannot see — the code compiles and denotes something else. What
 * is left gets an import written from the binding the derived file
 * used, so a package specifier survives verbatim and a relative one is
 * re-based. A name whose home does not export it is a refusal too: that
 * is the base's file being unable to name it.
 */
function dependencyImports(
  session: TsProjectSession,
  options: {
    roots: readonly ts.Node[];
    /** Whether a declaration belongs to the pulled member itself. */
    inMember: (node: ts.Node) => boolean;
    destination: Container;
    destinationFile: string;
    where: string;
  },
): ImportRequest[] {
  const { roots, inMember, destination, destinationFile, where } = options;
  const checker = session.checker();
  const scope = scopeAt(checker, destination);
  const requests: ImportRequest[] = [];

  for (const node of referencesUnder(roots)) {
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) continue;
    const declarations = symbol.declarations ?? [];
    if (declarations.length > 0 && declarations.every(inMember)) continue;
    const resolved = unalias(checker, symbol);
    // A global is declared in a script, so there is no module to import
    // it from and nothing to write.
    if (!(resolved.declarations ?? []).some((home) => ts.isExternalModule(home.getSourceFile()))) {
      continue;
    }

    const there = scope.get(node.text);
    if (there !== undefined) {
      if (unalias(checker, there) !== resolved) {
        throw new Error(
          `"${node.text}" means something different in ${destinationFile}, so ${where} would ` +
            'silently change meaning if it were declared there',
        );
      }
      continue;
    }
    if (
      declarations.some((home) => path.resolve(home.getSourceFile().fileName) === destinationFile)
    ) {
      continue;
    }

    const typeOnly = (resolved.flags & ts.SymbolFlags.Value) === 0;
    const binding = declarations[0];
    const originOf = (statement: ts.ImportDeclaration): ImportOrigin => {
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
        origin: originOf(statement),
        ...(binding.propertyName ? { propertyName: binding.propertyName.text } : {}),
        typeOnly: typeOnly || binding.isTypeOnly || statement.importClause!.isTypeOnly,
      });
      continue;
    }

    const home = binding?.getSourceFile();
    if (!home) continue;
    const moduleSymbol = checker.getSymbolAtLocation(home);
    const exported =
      moduleSymbol !== undefined &&
      checker.getExportsOfModule(moduleSymbol).some((candidate) => candidate.name === node.text);
    if (!exported) {
      throw new Error(
        `${where} names "${node.text}", which ${path.resolve(home.fileName)} does not export, so ` +
          `${destinationFile} cannot name it. Export it, or pull the member into a type in its ` +
          'own file.',
      );
    }
    requests.push({
      name: node.text,
      origin: { kind: 'file', file: path.resolve(home.fileName) },
      typeOnly,
    });
  }
  return requests;
}

/** Modifier flags as the compiler combines them for a declaration. */
function flagsOf(node: ts.Declaration): ts.ModifierFlags {
  return ts.getCombinedModifierFlags(node);
}

function hasImplementation(declaration: PullableMember): boolean {
  if (ts.isPropertyDeclaration(declaration)) return declaration.initializer !== undefined;
  return declaration.body !== undefined;
}

/** The type nodes a signature is built out of, for import resolution. */
function signatureNodes(declaration: PullableMember): ts.Node[] {
  const nodes: ts.Node[] = [];
  if (ts.isPropertyDeclaration(declaration)) {
    if (declaration.type) nodes.push(declaration.type);
    return nodes;
  }
  for (const parameter of declaration.parameters ?? []) {
    if (parameter.type) nodes.push(parameter.type);
  }
  for (const typeParameter of (declaration as ts.MethodDeclaration).typeParameters ?? []) {
    nodes.push(typeParameter);
  }
  if (declaration.type) nodes.push(declaration.type);
  return nodes;
}

export const pullMembersUp: Tool<PullMembersUpInput, PullMembersUpOutput, TsProjectSession> = {
  name: 'ts/refactors/pull-members-up',
  description:
    "Moves members from a derived class up into a type it inherits from — ReSharper's Pull " +
    'Members Up. A base class takes the whole member: the declaration, its body, and the ' +
    'imports the body needs, removed from the derived class. An interface cannot hold an ' +
    'implementation, so only the signature goes up and the class keeps its body — a different ' +
    'edit, which must be asked for with asAbstract, and the same shape asAbstract produces ' +
    'against an abstract base class. Nothing outside the two types changes: inheritance keeps ' +
    'every call site resolving, so there is no project-wide reference rewrite. Target the class ' +
    'by name (symbol) or exact position, name the members to pull, and name the destination ' +
    'with `to` when the class has more than one supertype. Refuses a member that reads private ' +
    'or #-private state staying behind, one that reads `this` members the destination does not ' +
    'declare, one whose types the destination\'s file cannot name, one reaching `super`, a ' +
    'destination in a .d.ts or otherwise outside the writable compilation, a name the ' +
    'destination already declares, and a hierarchy the checker cannot close (a mixin base ' +
    'could be hiding another declaration). Other subtypes of the destination that declare the ' +
    'same member are reported in siblings and warned about: their own version keeps winning, ' +
    'so the pulled-up one is dead for them. Dry-run by default; apply: true writes to disk ' +
    'unless the typecheck reports newDiagnostics.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      symbol: { type: 'string', description: 'Derived class to pull members out of' },
      members: {
        type: 'array',
        items: { type: 'string' },
        description: 'Member names to pull up',
      },
      to: {
        type: 'string',
        description: 'Destination supertype, required when the class has more than one',
      },
      asAbstract: {
        type: 'boolean',
        description:
          'Leave a signature on the destination and the implementation where it is (required ' +
          'for an interface destination when the member has a body or an initializer)',
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    required: ['members'],
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      members: { type: 'array', items: { type: 'string' } },
      siblings: {
        type: 'array',
        description: 'Subtypes of the destination that keep their own declaration',
        items: {
          type: 'object',
          properties: {
            container: { type: 'string' },
            file: { type: 'string' },
            line: { type: 'integer' },
          },
          required: ['container', 'file', 'line'],
        },
      },
    },
    ['members', 'siblings'],
  ),

  async run(session, input) {
    const checker = session.checker();
    const warnings: string[] = [];

    if (!Array.isArray(input.members) || input.members.length === 0) {
      throw new Error('members is required: name at least one member to pull up');
    }

    // The class.
    const target = resolveTarget(session, input);
    const declaration = declarationAt(target);
    if (!ts.isClassDeclaration(declaration)) {
      throw new Error(
        `Pull Members Up targets a class; the declaration here is a ` +
          `${ts.SyntaxKind[declaration.kind]}`,
      );
    }
    const derived = declaration;
    const derivedName = nameOf(derived);
    const derivedSource = derived.getSourceFile();
    const derivedFile = path.resolve(derivedSource.fileName);

    // The destination.
    const heritage = heritageOf(derived, checker);
    if (heritage.supertypes.length === 0) {
      throw new Error(
        heritage.unresolved.length > 0
          ? `${derivedName}'s supertypes cannot be resolved (${heritage.unresolved.join(', ')}); a ` +
              'mixin call or an unresolved import names no declaration to pull members into'
          : `${derivedName} extends nothing and implements nothing, so there is no type to pull ` +
              'members up into. ts/refactors/extract-superclass creates one.',
      );
    }
    let destination: Supertype;
    if (input.to !== undefined) {
      const matches = heritage.supertypes.filter((supertype) => supertype.name === input.to);
      if (matches.length === 0) {
        throw new Error(
          `${derivedName} does not inherit from "${input.to}". Its supertypes are ` +
            `${heritage.supertypes.map((s) => `${s.name} (${s.kind})`).join(', ')}.`,
        );
      }
      if (matches.length > 1) {
        throw new Error(
          `"${input.to}" names more than one of ${derivedName}'s supertypes:\n  ` +
            matches.map((match) => locationOf(match.node)).join('\n  '),
        );
      }
      destination = matches[0]!;
    } else if (heritage.supertypes.length === 1) {
      destination = heritage.supertypes[0]!;
    } else {
      throw new Error(
        `${derivedName} has more than one supertype ` +
          `(${heritage.supertypes.map((s) => `${s.name} (${s.kind})`).join(', ')}); name the ` +
          'destination with "to"',
      );
    }

    const destinationNode = destination.node;
    const destinationSource = destinationNode.getSourceFile();
    const destinationFile = path.resolve(destinationSource.fileName);
    const intoInterface = ts.isInterfaceDeclaration(destinationNode);

    if (destinationSource.isDeclarationFile) {
      throw new Error(
        `${destination.name} is declared in ${destinationFile}, a declaration file. A .d.ts ` +
          'describes code this project does not own, so there is nothing to pull members into.',
      );
    }
    if (
      !session
        .compilationFiles()
        .some((sourceFile) => path.resolve(sourceFile.fileName) === destinationFile)
    ) {
      throw new Error(
        `${destination.name} lives in ${destinationFile}, which is not part of the writable ` +
          'compilation (a dependency, or outside this project)',
      );
    }

    // The members.
    const available = new Map<string, PullableMember[]>();
    for (const member of derived.members) {
      if (!isPullable(member)) continue;
      const name = ts.isIdentifier(member.name)
        ? member.name.text
        : ts.isPrivateIdentifier(member.name)
          ? member.name.text
          : undefined;
      if (name === undefined) continue;
      available.set(name, [...(available.get(name) ?? []), member]);
    }
    const missing = input.members.filter((name) => !available.has(name));
    if (missing.length > 0) {
      throw new Error(
        `${derivedName} declares no member named ${missing.map((n) => `"${n}"`).join(', ')}. ` +
          `Available: ${[...available.keys()].join(', ') || '(none)'}. An inherited member is not ` +
          'offered: its declaration already lives above this class.',
      );
    }
    const wanted = new Set(input.members);
    const groups: MemberGroup[] = [...available.entries()]
      .filter(([name]) => wanted.has(name))
      .map(([name, declarations]) => ({ name, declarations }));
    const pulledNames = new Set(groups.map((group) => group.name));
    const pulledDeclarations = groups.flatMap((group) => group.declarations);
    const where = `${derivedName}.${[...pulledNames].join('/')}`;

    for (const group of groups) {
      if (group.name.startsWith('#')) {
        throw new Error(
          `${derivedName}.${group.name} is a #private member, reachable only inside the class ` +
            'body that declares it. Moved to a base it would be unreadable from here, which is ' +
            'a hard error rather than a refactoring.',
        );
      }
      for (const member of group.declarations) {
        const flags = flagsOf(member);
        if ((ts.getDecorators(member) ?? []).length > 0) {
          throw new Error(
            `${derivedName}.${group.name} is decorated. A member decorator receives the ` +
              'prototype it is installed on, so moving the member changes what the decorator ' +
              'decorates — a runtime difference no typecheck reports.',
          );
        }
        if (flags & ts.ModifierFlags.Override) {
          throw new Error(
            `${derivedName}.${group.name} is marked \`override\`, so something above it already ` +
              'declares it. There is nothing to pull up.',
          );
        }
        if (intoInterface && flags & ts.ModifierFlags.Static) {
          throw new Error(
            `${derivedName}.${group.name} is static, and an interface describes instances. There ` +
              'is no signature for a static member to occupy.',
          );
        }
        if (
          intoInterface &&
          flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)
        ) {
          throw new Error(
            `${derivedName}.${group.name} is ` +
              `${flags & ts.ModifierFlags.Private ? 'private' : 'protected'}, and an interface ` +
              'member has no accessibility — every member of one is public',
          );
        }
        if (destinationNode.members.some((other) => other.name?.getText() === group.name)) {
          throw new Error(
            `${destination.name} already declares "${group.name}". Pulling this one up would be ` +
              'a redeclaration, not a move.',
          );
        }
      }
    }

    // Who else declares these names under the destination. A member on a
    // sibling keeps winning for that sibling, so the pulled-up one is
    // dead there — correct, and something the caller has to be told.
    const siblings: SiblingDeclaration[] = [];
    const unresolvedHierarchy = new Set<string>();
    const overriddenAbove: string[] = [];
    for (const group of groups) {
      const hierarchy = hierarchyAt(session, destinationNode, group.name);
      for (const entry of hierarchy.unresolved) unresolvedHierarchy.add(entry);
      for (const above of hierarchy.supertypes) {
        overriddenAbove.push(`${above.container}.${group.name}`);
      }
      for (const below of hierarchy.subtypes) {
        if (below.container === derivedName && path.resolve(below.file) === derivedFile) continue;
        siblings.push({
          container: below.container,
          file: path.resolve(below.file),
          line: below.line,
        });
      }
    }
    if (unresolvedHierarchy.size > 0) {
      throw new Error(
        `${destination.name}'s hierarchy cannot be closed (${[...unresolvedHierarchy].join(', ')}). ` +
          'A subtype reached through a mixin could declare one of these members, and pulling ' +
          'one up without seeing it would silently change which body runs.',
      );
    }
    if (siblings.length > 0) {
      warnings.push(
        `${siblings
          .map((sibling) => `${sibling.container} (${sibling.file}:${sibling.line + 1})`)
          .join(', ')} also declare${siblings.length === 1 ? 's' : ''} one of these members. ` +
          'Their declaration is left alone, which keeps their behaviour — but it means the ' +
          'pulled-up version never runs for them.',
      );
    }
    if (overriddenAbove.length > 0) {
      warnings.push(
        `${[...new Set(overriddenAbove)].join(', ')} already exists above ${destination.name}, so ` +
          'the pulled-up member becomes an override of it rather than a new declaration.',
      );
    }

    // Which of the two edits this is.
    const implemented = pulledDeclarations.filter(hasImplementation);
    if (intoInterface && implemented.length > 0 && input.asAbstract !== true) {
      throw new Error(
        `${destination.name} is an interface, and a TypeScript interface holds no ` +
          `implementations — so ${implemented
            .map((member) => (member.name as ts.Identifier).text)
            .join(', ')} cannot move into it, only its signature can be copied there. That is a ` +
          'different edit from a move: the class keeps its body, and it has to keep it, because ' +
          `a class that stops declaring a member it implements is TS2420. Pass asAbstract: true ` +
          'to ask for the signature.',
      );
    }
    const signatureOnly = intoInterface || input.asAbstract === true;

    if (!intoInterface && input.asAbstract === true) {
      if (!(flagsOf(destinationNode) & ts.ModifierFlags.Abstract)) {
        throw new Error(
          `${destination.name} is not an abstract class, so it cannot hold an abstract member. ` +
            'Make it abstract, or pull the member up with its body.',
        );
      }
      for (const member of pulledDeclarations) {
        const flags = flagsOf(member);
        if (flags & ts.ModifierFlags.Private) {
          throw new Error(
            `${derivedName}.${(member.name as ts.Identifier).text} is private, and \`private ` +
              'abstract\` is not a legal member — an abstract declaration exists to be ' +
              'implemented by a subclass, which a private one never can be',
          );
        }
        if (flags & ts.ModifierFlags.Static) {
          throw new Error(
            `${derivedName}.${(member.name as ts.Identifier).text} is static, and a static ` +
              'member cannot be abstract',
          );
        }
      }
    }

    const memberSpans = pulledDeclarations.map((member) => ({
      start: member.getStart(derivedSource, true),
      end: member.getEnd(),
    }));
    const inMember = (node: ts.Node): boolean =>
      node.getSourceFile() === derivedSource &&
      memberSpans.some((span) => node.getStart() >= span.start && node.getEnd() <= span.end);

    // What the member reads off `this`. Only a real move needs this: a
    // signature pull leaves the body exactly where it is.
    const closure = supertypeClosure(destinationNode, checker);
    if (!signatureOnly) {
      const computedAccess: string[] = [];
      const checkThis = (node: ts.Node): void => {
        if (node.kind === ts.SyntaxKind.SuperKeyword) {
          throw new Error(
            `${where} reaches \`super\`, which means ${destination.name} inside the class it is ` +
              'in now and whatever sits above it after the move — a different object, silently',
          );
        }
        if (
          ts.isElementAccessExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ThisKeyword &&
          !ts.isStringLiteralLike(node.argumentExpression)
        ) {
          computedAccess.push(locationOf(node));
        }
        if (
          ts.isPropertyAccessExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          const accessed = node.name;
          if (ts.isPrivateIdentifier(accessed)) {
            if (!pulledNames.has(accessed.text)) {
              throw new Error(
                `${where} reads \`this.${accessed.text}\`. A #-private name is scoped to the ` +
                  `class body that declares it, so it stays in ${derivedName} and would be ` +
                  `unreadable from ${destination.name}. Pull it up too, or leave the member here.`,
              );
            }
          } else if (!pulledNames.has(accessed.text)) {
            const name = accessed.text;
            const declaredAbove = [...closure].some((container) =>
              declaresMemberNamed(container, name),
            );
            if (!declaredAbove) {
              // A name off `Object.prototype` and friends is declared in
              // lib, not in this project, and travels with the object.
              const symbol = checker.getSymbolAtLocation(accessed);
              const fromLib =
                symbol !== undefined &&
                (symbol.declarations ?? []).length > 0 &&
                (symbol.declarations ?? []).every((home) => home.getSourceFile().isDeclarationFile);
              if (!fromLib) {
                const own = ownDeclarationOf(derived, name);
                const isPrivate =
                  own !== undefined && (flagsOf(own) & ts.ModifierFlags.Private) !== 0;
                throw new Error(
                  isPrivate
                    ? `${where} reads \`this.${name}\`, which is private to ${derivedName} and ` +
                        `stays there. ${destination.name} could not reach it. Pull "${name}" up ` +
                        'too, or make it protected first.'
                    : `${where} reads \`this.${name}\`, which ${destination.name} does not ` +
                        `declare — it belongs to ${derivedName}. The member cannot be pulled ` +
                        `above the state it reads; pull "${name}" up first.`,
                );
              }
            }
          }
        }
        node.forEachChild(checkThis);
      };
      for (const member of pulledDeclarations) checkThis(member);
      if (computedAccess.length > 0) {
        warnings.push(
          `${where} reads a member of \`this\` through a computed key at ` +
            `${computedAccess.join(', ')}; which member that is resolves at runtime, so neither ` +
            'this tool nor the typecheck can say whether it survives the move.',
        );
      }
    }

    // The text going into the destination.
    const destinationIndent = ' '.repeat(
      destinationNode.members[0]
        ? columnOf(destinationNode.members[0], destinationSource)
        : columnOf(destinationNode, destinationSource) + (formatSettings(session).indentSize ?? 2),
    );

    const typeTextOf = (type: ts.Type, what: string): string => {
      const text = checker.typeToString(
        type,
        destinationNode,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
      );
      if (text.includes('import(')) {
        throw new Error(
          `${what} has no written type annotation, and the type the checker reports for it ` +
            `(\`${text}\`) contains an absolute \`import("…")\` path — the fallback typeToString ` +
            `uses for a name ${destinationFile} cannot resolve. Annotate the declaration and run ` +
            'again.',
        );
      }
      return text;
    };

    /**
     * A binding pattern with its defaults removed. A destructured
     * parameter keeps its pattern in a signature — the names document
     * the shape — but a default *inside* the pattern is a parameter
     * initializer, which a signature cannot hold: TS2371, once each.
     */
    const patternWithoutDefaults = (name: ts.BindingName): string => {
      if (ts.isIdentifier(name)) return name.text;
      const elements = name.elements
        .map((element) => {
          if (ts.isOmittedExpression(element)) return '';
          const dots = element.dotDotDotToken ? '...' : '';
          const property = element.propertyName
            ? `${element.propertyName.getText(derivedSource)}: `
            : '';
          return `${dots}${property}${patternWithoutDefaults(element.name)}`;
        })
        .join(', ');
      return ts.isObjectBindingPattern(name) ? `{ ${elements} }` : `[${elements}]`;
    };

    const parameterText = (parameter: ts.ParameterDeclaration): string => {
      const rest = parameter.dotDotDotToken ? '...' : '';
      const name = patternWithoutDefaults(parameter.name);
      // A default is not writable in a signature, so a defaulted
      // parameter becomes an optional one — the same thing every caller
      // sees, since the default is applied inside the body that stays.
      const optional =
        parameter.questionToken !== undefined ||
        (parameter.initializer !== undefined && parameter.dotDotDotToken === undefined)
          ? '?'
          : '';
      const type = parameter.type
        ? parameter.type.getText(derivedSource)
        : typeTextOf(
            checker.getTypeAtLocation(parameter),
            `parameter "${parameter.name.getText(derivedSource)}" at ${locationOf(parameter)}`,
          );
      return `${rest}${name}${optional}: ${type}`;
    };

    const modifiersFor = (member: PullableMember): string => {
      if (intoInterface) {
        return ts.isPropertyDeclaration(member) && flagsOf(member) & ts.ModifierFlags.Readonly
          ? 'readonly '
          : '';
      }
      const flags = flagsOf(member);
      const parts: string[] = [];
      if (flags & ts.ModifierFlags.Protected) parts.push('protected');
      parts.push('abstract');
      if (ts.isPropertyDeclaration(member) && flags & ts.ModifierFlags.Readonly) {
        parts.push('readonly');
      }
      return `${parts.join(' ')} `;
    };

    const signatureText = (member: PullableMember): string => {
      const name = (member.name as ts.Identifier).text;
      const modifiers = modifiersFor(member);
      if (ts.isPropertyDeclaration(member)) {
        const optional = member.questionToken ? '?' : '';
        const type = member.type
          ? member.type.getText(derivedSource)
          : typeTextOf(
              checker.getWidenedType(checker.getTypeAtLocation(member)),
              `property "${name}" at ${locationOf(member)}`,
            );
        return `${modifiers}${name}${optional}: ${type};`;
      }
      if (ts.isGetAccessorDeclaration(member)) {
        const type = member.type
          ? member.type.getText(derivedSource)
          : typeTextOf(
              checker.getTypeAtLocation(member),
              `getter "${name}" at ${locationOf(member)}`,
            );
        return `${modifiers}get ${name}(): ${type};`;
      }
      if (ts.isSetAccessorDeclaration(member)) {
        const parameter = member.parameters[0];
        return `${modifiers}set ${name}(${parameter ? parameterText(parameter) : 'value: unknown'});`;
      }
      const typeParameters = member.typeParameters
        ? `<${member.typeParameters.map((p) => p.getText(derivedSource)).join(', ')}>`
        : '';
      const parameters = member.parameters.map(parameterText).join(', ');
      const optional = member.questionToken ? '?' : '';
      const signature = checker.getSignatureFromDeclaration(member);
      if (!member.type && !signature) {
        throw new Error(
          `The checker reports no signature for "${name}" at ${locationOf(member)}, so its ` +
            'return type cannot be written. Annotate it and run again.',
        );
      }
      const returns = member.type
        ? member.type.getText(derivedSource)
        : typeTextOf(signature!.getReturnType(), `method "${name}" at ${locationOf(member)}`);
      return `${modifiers}${name}${optional}${typeParameters}(${parameters}): ${returns};`;
    };

    const blocks: string[] = [];
    for (const member of pulledDeclarations) {
      const column = columnOf(member, derivedSource);
      if (signatureOnly) {
        const doc = jsDocOf(member, derivedSource);
        const lines = [...(doc ? [doc] : []), signatureText(member)].join('\n');
        blocks.push(reindent(lines, column, destinationIndent));
        continue;
      }
      const text = derivedSource.text.slice(member.getStart(derivedSource, true), member.getEnd());
      if (hasMultilineTemplate(member, derivedSource)) {
        warnings.push(
          `${derivedName}.${(member.name as ts.Identifier).text} contains a multi-line template ` +
            'literal, whose indentation is string content rather than layout, so the pulled-up ' +
            'code keeps its original indentation.',
        );
        blocks.push(text);
        continue;
      }
      blocks.push(reindent(text, column, destinationIndent));
    }
    const insertText = blocks.join('\n\n');

    // Imports the destination's file needs. A signature carries only the
    // names in its types; a body carries everything it reads.
    const changes: Record<string, TextEdit[]> = {};
    const add = (file: string, edit: TextEdit): void => {
      changes[file] = [...(changes[file] ?? []), edit];
    };

    if (destinationFile !== derivedFile) {
      const roots = signatureOnly
        ? pulledDeclarations.flatMap(signatureNodes)
        : pulledDeclarations;
      const requests = dependencyImports(session, {
        roots,
        inMember,
        destination: destinationNode,
        destinationFile,
        where,
      });
      const unique: ImportRequest[] = [];
      for (const request of requests) {
        if (!unique.some((other) => other.name === request.name)) unique.push(request);
      }
      for (const edit of importEdits(session, destinationFile, unique)) add(destinationFile, edit);
    }

    // The insertion.
    const last = destinationNode.members[destinationNode.members.length - 1];
    const offset = last ? last.getEnd() : destinationNode.members.end;
    const at = (position: number) => destinationSource.getLineAndCharacterOfPosition(position);
    add(destinationFile, {
      range: { start: at(offset), end: at(offset) },
      newText: last ? `\n\n${insertText}` : `\n${insertText}\n`,
    });

    // The removal, and the imports it orphans.
    if (!signatureOnly) {
      for (const span of removalSpans(derivedSource, pulledDeclarations)) {
        add(derivedFile, {
          range: {
            start: derivedSource.getLineAndCharacterOfPosition(span.start),
            end: derivedSource.getLineAndCharacterOfPosition(span.end),
          },
          newText: '',
        });
      }
      if (destinationFile !== derivedFile) {
        const dead = new Set<ts.Node>(referencesUnder(pulledDeclarations));
        for (const edit of unusedImportEdits(session, derivedSource, dead)) add(derivedFile, edit);
      }
    }

    // Warnings the typecheck will not raise on its own.
    if (signatureOnly) {
      warnings.push(
        intoInterface
          ? `${destination.name} is an interface, so only the signature moved: ${derivedName} ` +
              'keeps every body, and it has to — a class is checked against what it implements.'
          : `Only the signature moved: ${derivedName} keeps every body, and every other ` +
              `concrete subclass of ${destination.name} must now declare these members or fail ` +
              'TS2515.',
      );
    }
    const restricted = pulledDeclarations.filter(
      (member) => flagsOf(member) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected),
    );
    if (restricted.length > 0 && !intoInterface) {
      warnings.push(
        `${restricted
          .map((member) => (member.name as ts.Identifier).text)
          .join(', ')} keeps its accessibility on ${destination.name}, where it is now visible ` +
          `to every subtype rather than to ${derivedName} alone.`,
      );
    }
    if (pulledDeclarations.some((member) => flagsOf(member) & ts.ModifierFlags.Static)) {
      warnings.push(
        `A static pulled onto ${destination.name} is still reachable as ` +
          `${derivedName}.<member>, because static members are inherited — so no call site ` +
          'changes, and none has to.',
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
      members: groups.map((group) => group.name),
      siblings: siblings.sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
      ),
    };

    if (input.apply !== true || newDiagnostics.length > 0) return { applied: false, ...output };
    session.invalidate(await applyWorkspaceEdit(edit));
    return { applied: true, ...output };
  },
};
