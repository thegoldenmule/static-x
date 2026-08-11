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
import { moveSymbol } from '../move-symbol/move-symbol.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences, isUse, type ClassifiedReference } from '../references.js';
import { formatSettings, userPreferences } from '../refactor-action.js';
import { locationOf } from '../signatures.js';
import { unalias } from '../substitution.js';

/**
 * Moves a static member out of the class that declares it — ReSharper's
 * Move to Another Type — and re-points every reference.
 *
 * The C# operation has one destination shape, because a static member
 * has nowhere else to live. TypeScript has two, and the second is
 * usually the right one: a module is already a namespace, so a static
 * helper on a class is a C# habit rather than a TypeScript design, and a
 * plain exported function tree-shakes where a static member does not.
 * So `toClass` moves the member to another class and `toFile` demotes it
 * to a module-level binding, rewriting `A.m()` to `m()` and importing it
 * where it is used.
 *
 * A module-level binding is not this tool's problem: moving one between
 * files is `move-symbol`, which drives TypeScript's own move engine, and
 * a target that turns out to be top-level is handed straight to it
 * rather than reimplemented here.
 *
 * The refusals are where the value is. A static member that reads `this`
 * means its own class, and quietly means a different class after the
 * move; one that reads another static of the class it is leaving loses
 * that reference; one shared with a base class or an override is not the
 * only declaration of itself. None of those is visible to a typecheck
 * once the edit compiles, which is why each is decided before an edit is
 * built rather than left to the guard.
 */

export interface MoveMemberInput {
  /** Member (or module-level binding) to move, by name. */
  symbol?: string;
  /** Class the member is declared on, when the name is not unique. */
  class?: string;
  file?: string;
  line?: number;
  character?: number;
  /** Destination class. Exactly one of toClass/toFile. */
  toClass?: string;
  /** Destination module, existing or to be created. */
  toFile?: string;
  apply?: boolean;
}

export interface MemberReference {
  file: string;
  line: number;
  character: number;
}

export interface MoveMemberOutput extends RefactorOutput {
  /** Every reference the edit re-points, in the pre-edit tree. */
  references: MemberReference[];
}

type MovableMember = ts.MethodDeclaration | ts.PropertyDeclaration;

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



/**
 * An identifier that refers to something rather than naming it. Property
 * names, the right of a qualified name and every declaration's own name
 * are excluded, so what remains is the set of names whose meaning is
 * decided by the surrounding scope — which is exactly the set that has
 * to still resolve after the code moves.
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
function references(root: ts.Node): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isReference(node)) found.push(node);
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}


/**
 * The span that removes a node along with its own line and the blank
 * line that separated it from what came before.
 *
 * Taking the blank line *before* rather than after is what keeps the two
 * cases from fighting: the last member of a class has a blank line above
 * it and its closing brace below, while the last import of a block has a
 * statement above it and the blank line separating imports from code
 * below. Removing the following blank line would leave `}` hanging under
 * an empty line in the first case and weld the imports to the code in
 * the second. The exception is a node that opens its container, where
 * there is no preceding blank to take and keeping the following one
 * would open the body with an empty line.
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

/** Column the node starts at, which is the indent its text assumes. */
function columnOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, true)).character;
}

interface Destination {
  /** Absolute path of the file the member lands in. */
  file: string;
  /** The class it lands in, when the destination is a class. */
  class?: ts.ClassDeclaration;
  /** True when the destination file does not exist yet. */
  created: boolean;
  /** Node to resolve names against, absent for a file being created. */
  scope?: ts.Node;
}

/** The class a resolved target declares a member on. */
function containerOf(declaration: ts.Node): ts.ClassLikeDeclaration | undefined {
  const parent = declaration.parent as ts.Node | undefined;
  return parent && ts.isClassLike(parent) ? parent : undefined;
}

/**
 * Resolve the member to move. `class` narrows before `resolveTarget`
 * would refuse: a static named `shipping` on two different classes is
 * two symbols, and picking either without being told is how a tool
 * refactors the wrong one.
 */
function resolveMember(session: TsProjectSession, input: MoveMemberInput): ResolvedTarget {
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

/** The class named by `toClass`, or a refusal naming what was found. */
function destinationClass(session: TsProjectSession, name: string): ts.ClassDeclaration {
  const found = findDeclarations(session, name).filter(
    (candidate) => candidate.declaration && ts.isClassDeclaration(candidate.declaration),
  );
  if (found.length === 0) {
    const anything = findDeclarations(session, name);
    throw new Error(
      anything.length === 0
        ? `No class named "${name}" in this project`
        : `"${name}" is not a class (found ${ts.SyntaxKind[anything[0]!.declaration!.kind]})`,
    );
  }
  if (found.length > 1) {
    const locations = found
      .map((candidate) => `${candidate.file}:${candidate.position.line + 1}`)
      .join('\n  ');
    throw new Error(`"${name}" names more than one class:\n  ${locations}`);
  }
  return found[0]!.declaration as ts.ClassDeclaration;
}

/**
 * The qualifier a reference reads the member through — the `A` of `A.m`,
 * whether written as an expression or as a type-position qualified name.
 * A reference this cannot describe is one the rewrite cannot reach.
 */
function qualifierOf(node: ts.Node): { expression: ts.Node; nameStart: number } | undefined {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) return undefined;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return { expression: parent.expression, nameStart: node.getStart() };
  }
  if (ts.isQualifiedName(parent) && parent.right === node) {
    return { expression: parent.left, nameStart: node.getStart() };
  }
  return undefined;
}

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
  const clause =
    request.form === 'namespace'
      ? `* as ${request.name}`
      : request.form === 'default'
        ? request.name
        : `{ ${request.propertyName && request.propertyName !== request.name ? `${request.propertyName} as ${request.name}` : request.name} }`;
  return `import ${modifier}${clause} from ${quote}${specifier}${quote};`;
}


/**
 * What the pruning pass took out of a file, so the pass that adds
 * imports can avoid anchoring to it.
 *
 * Both passes edit the same few lines: the file that only imported `A`
 * to reach `A.m()` loses that import and gains one for the destination.
 * An insertion anchored to the end of a statement another edit deletes
 * sits inside that deletion, and `applyTextEdits` rejects the pair as
 * overlapping — so the two passes are ordered, and this is what the
 * first tells the second.
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
 * Edits that bind `requests` in `file`.
 *
 * A name is folded into an existing named import from the same module
 * where there is one; the rest go in one block after the last import, so
 * a file never grows two import statements for the same module.
 */
function importEdits(
  session: TsProjectSession,
  file: string,
  requests: readonly ImportRequest[],
  pruned: Pruned,
): TextEdit[] {
  const sourceFile = session.program().getSourceFile(file);
  const edits: TextEdit[] = [];
  const fresh: ImportRequest[] = [];

  if (!sourceFile) {
    // A file the edit creates: its whole text is one insertion at 0:0,
    // and the imports lead it.
    const zero = { line: 0, character: 0 };
    const text = requests.map((request) => importStatement(session, file, request)).join('\n');
    return text === '' ? [] : [{ range: { start: zero, end: zero }, newText: `${text}\n\n` }];
  }

  const at = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset);
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
      // vacated lines, so the blank line that followed them is still
      // the one blank line between imports and code.
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
 * Import specifiers in `file` that nothing refers to once `dead` is
 * gone.
 *
 * Not tidiness: under `noUnusedLocals` the import the move orphans is
 * TS6133, which the guard reports as a diagnostic the edit introduced
 * and refuses the whole move over. The file that only imported `A` to
 * call `A.m()` is the common case, so leaving it would make the tool
 * unusable in exactly the projects that most want it.
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
      // `import Default, { gone }` — the default binding stays.
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
 * Imports the destination needs so the moved member still means what it
 * meant.
 *
 * Every free name in the member is re-resolved against the destination's
 * scope. One already bound there to the same symbol needs nothing; one
 * bound there to a *different* symbol is a refusal, because that is the
 * failure the guard cannot see — the code compiles and computes
 * something else. Everything left needs an import, written from the
 * binding the source file used rather than from the symbol's home, so a
 * package specifier survives as itself and a relative one is re-based.
 *
 * A global needs nothing at all: it is declared in a script rather than
 * a module, so there is no module to import it from.
 */
function dependencyImports(
  session: TsProjectSession,
  options: {
    member: MovableMember;
    /** Whether a node is part of the member, and so travels with it. */
    inMember: (node: ts.Node) => boolean;
    destination: Destination;
    /** How refusal messages name the member. */
    where: string;
  },
): ImportRequest[] {
  const { member, inMember, destination, where } = options;
  const checker = session.checker();
  const scope = destination.scope
    ? scopeAt(checker, destination.scope)
    : new Map<string, ts.Symbol>();
  const requests: ImportRequest[] = [];

  for (const node of references(member)) {
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
      if (unalias(checker, there) !== resolved) {
        throw new Error(
          `"${node.text}" means something different in ${destination.file}, so ${where} would ` +
            'silently change meaning if it moved there',
        );
      }
      continue;
    }
    if (declarations.some((home) => path.resolve(home.getSourceFile().fileName) === destination.file)) {
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
        `${where} reads "${node.text}", which ${path.resolve(home.fileName)} does not export, ` +
          `so ${destination.file} cannot name it`,
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

export const moveMember: Tool<MoveMemberInput, MoveMemberOutput, TsProjectSession> = {
  name: 'ts/refactors/move-member',
  description:
    "Moves a static member out of the class that declares it — ReSharper's Move to Another " +
    'Type — and re-points every reference. Two destinations: toClass moves the member onto ' +
    'another class, rewriting `A.m()` to `B.m()` and importing B where it is used; toFile ' +
    'demotes it to a module-level binding, rewriting `A.m()` to `m()` and importing it where ' +
    'it is used. The second is usually the idiomatic one in TypeScript, where a module is ' +
    'already a namespace and a free function tree-shakes where a static member does not. A ' +
    'static method becomes `export function`, a static property becomes `export const`. ' +
    'Target the member by name (symbol), narrowed by class when the name is not unique, or ' +
    'by exact position; a target that turns out to be a top-level declaration is handed to ' +
    'ts/refactors/move-symbol instead. Refuses a member that reads `this` or another static ' +
    'of the class it is leaving, an instance member (that is move-instance-method), a member ' +
    'a base class or subclass also declares, a reference reached through a subclass or a ' +
    'string key, and a destination where the name already means something else. Imports the ' +
    'moved code needs are added at the destination and the ones it orphans are removed. ' +
    'Dry-run by default; apply: true writes to disk unless the typecheck reports ' +
    'newDiagnostics.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      class: {
        type: 'string',
        description: 'Class the member is declared on, when the name is not unique',
      },
      toClass: { type: 'string', description: 'Destination class (exactly one of toClass/toFile)' },
      toFile: {
        type: 'string',
        description:
          'Destination module, existing or to be created (relative to the project root); the ' +
          'member becomes a module-level binding',
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      references: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            line: { type: 'integer' },
            character: { type: 'integer' },
          },
        },
      },
    },
    ['references'],
  ),

  async run(session, input) {
    if ((input.toClass === undefined) === (input.toFile === undefined)) {
      throw new Error('Give exactly one destination: toClass or toFile');
    }

    const target = resolveMember(session, input);
    const declaration = declarationAt(target);
    const container = containerOf(declaration);
    const checker = session.checker();

    // A top-level declaration is move-symbol's job, and move-symbol
    // drives TypeScript's own move engine — which exports the symbol,
    // carries the names its body needs, and rewrites every importer's
    // specifier. Reimplementing that here would be a second, worse copy.
    if (!container) {
      if (input.toFile === undefined) {
        throw new Error(
          `"${declaration.name?.getText(target.sourceFile) ?? input.symbol}" is a module-level ` +
            'declaration, not a class member. Moving one onto a class is not this tool; give ' +
            'toFile to move it to another module.',
        );
      }
      const uses = classifyReferences(session, target.file, target.offset).filter(isUse);
      const moved = await moveSymbol.run(session, {
        file: target.file,
        line: target.position.line,
        character: target.position.character,
        toFile: input.toFile,
        ...(input.apply === undefined ? {} : { apply: input.apply }),
      });
      return {
        applied: moved.applied,
        edit: moved.edit,
        filesChanged: moved.filesChanged,
        newDiagnostics: moved.newDiagnostics,
        warnings: [
          ...moved.warnings,
          'The target is a module-level declaration, so this was delegated to ' +
            "ts/refactors/move-symbol, which drives TypeScript's own move engine.",
        ],
        references: uses.map((use) => ({
          file: use.file,
          line: use.line,
          character: use.character,
        })),
      };
    }

    const sourceFile = target.sourceFile;
    const memberName = declaration.name?.getText(sourceFile) ?? '(unnamed)';
    const className = container.name?.text ?? '(anonymous class)';
    const where = `${className}.${memberName}`;

    if (!ts.isMethodDeclaration(declaration) && !ts.isPropertyDeclaration(declaration)) {
      throw new Error(
        `${where} is a ${ts.SyntaxKind[declaration.kind]}; only a static method or property moves`,
      );
    }
    const member: MovableMember = declaration;
    if (member.name && !ts.isIdentifier(member.name)) {
      throw new Error(
        `${where} has a ${ts.isPrivateIdentifier(member.name) ? 'private' : 'computed'} name, ` +
          'which cannot be re-bound in another container',
      );
    }
    const modifiers = ts.getCombinedModifierFlags(member);
    if (!(modifiers & ts.ModifierFlags.Static)) {
      throw new Error(
        `${where} is an instance member. Moving one carries its receiver with it, which is a ` +
          'different operation (ts/refactors/move-instance-method); this tool moves statics.',
      );
    }
    if (modifiers & ts.ModifierFlags.Abstract || (ts.isMethodDeclaration(member) && !member.body)) {
      throw new Error(`${where} has no body to move`);
    }
    // A decorator is applied by the class that declares the member, and
    // a module-level function cannot carry one at all — so moving the
    // member without it would drop behaviour no typecheck asks about.
    if ((ts.getDecorators(member) ?? []).length > 0) {
      throw new Error(`${where} is decorated, and the decorator does not travel with it`);
    }

    const hierarchy = memberHierarchy(session, member);
    if (hierarchy.unresolved.length > 0) {
      throw new Error(
        `${className}'s hierarchy cannot be resolved (${hierarchy.unresolved.join(', ')}), so a ` +
          'declaration of this member elsewhere in it could be invisible',
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

    const memberStart = member.getStart(sourceFile, true);
    const memberEnd = member.getEnd();
    const inMember = (node: ts.Node): boolean =>
      node.getSourceFile() === sourceFile &&
      node.getStart() >= memberStart &&
      node.getEnd() <= memberEnd;

    // `this` in a static member is the class itself, so after the move
    // it silently means a different class — or, at module scope,
    // nothing. Every `this` counts, including the ones inside a nested
    // function where it means something else again: telling those apart
    // buys nothing, because the member is unmovable either way.
    let readsReceiver = false;
    const findReceiver = (node: ts.Node): void => {
      if (readsReceiver) return;
      if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
        readsReceiver = true;
        return;
      }
      node.forEachChild(findReceiver);
    };
    findReceiver(member);
    if (readsReceiver) {
      throw new Error(
        `${where} reads \`this\`, which in a static member is ${className} itself. It would ` +
          'mean a different class after the move, and nothing at module scope.',
      );
    }

    const containerSymbol = container.name
      ? checker.getSymbolAtLocation(container.name)
      : undefined;

    // A reference to another static of the class being left behind does
    // not travel: it is the dependency the move is supposed to sever.
    const stranded = new Set<string>();
    const findStranded = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const symbol = checker.getSymbolAtLocation(node.expression);
        if (
          symbol !== undefined &&
          containerSymbol !== undefined &&
          unalias(checker, symbol) === containerSymbol &&
          node.name.text !== memberName
        ) {
          stranded.add(node.name.text);
        }
      }
      node.forEachChild(findStranded);
    };
    findStranded(member);
    if (stranded.size > 0) {
      throw new Error(
        `${where} reads ${[...stranded].map((name) => `${className}.${name}`).join(', ')}, which ` +
          'would stay behind. Move what it depends on first, or leave the member where it is.',
      );
    }

    // Destination.
    let destination: Destination;
    if (input.toClass !== undefined) {
      const into = destinationClass(session, input.toClass);
      if (into === container) throw new Error(`${where} already lives on ${input.toClass}`);
      destination = {
        file: path.resolve(into.getSourceFile().fileName),
        class: into,
        created: false,
        scope: into,
      };
      if (into.members.some((other) => other.name?.getText() === memberName)) {
        throw new Error(`${input.toClass} already declares a member named "${memberName}"`);
      }
    } else {
      const file = path.resolve(session.rootPath, input.toFile!);
      if (ts.sys.directoryExists(file)) {
        throw new Error(`Destination ${file} is a directory, not a file`);
      }
      const existing = session.program().getSourceFile(file);
      destination = { file, created: existing === undefined, ...(existing ? { scope: existing } : {}) };
      if (existing !== undefined) {
        const clash = scopeAt(checker, existing).get(memberName);
        if (clash !== undefined) {
          throw new Error(
            `"${memberName}" already means something else in ${file}, so the moved member ` +
              'cannot take that name at module scope',
          );
        }
      }
    }
    const toModuleScope = destination.class === undefined;

    if (toModuleScope && ts.isPropertyDeclaration(member)) {
      if (!member.initializer) {
        throw new Error(
          `${where} has no initializer, so there is no module-level binding to write`,
        );
      }
      if (member.questionToken) {
        throw new Error(`${where} is optional, which a module-level binding cannot be`);
      }
    }

    const warnings: string[] = [];
    if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) {
      warnings.push(
        `${where} is ${modifiers & ts.ModifierFlags.Private ? 'private' : 'protected'}; the ` +
          'moved declaration is visible to everything that can reach its new container.',
      );
    }

    // References.
    const uses = classifyReferences(session, target.file, target.offset).filter(isUse);
    const rewrites: { file: string; start: number; end: number; newText: string }[] = [];
    const dead = new Map<string, Set<ts.Node>>();
    const markDead = (node: ts.Node): void => {
      const file = path.resolve(node.getSourceFile().fileName);
      const set = dead.get(file) ?? new Set<ts.Node>();
      set.add(node);
      dead.set(file, set);
    };
    const needed = new Map<string, ImportRequest[]>();
    const request = (file: string, entry: ImportRequest): void => {
      const list = needed.get(file) ?? [];
      if (!list.some((other) => other.name === entry.name)) list.push(entry);
      needed.set(file, list);
    };

    const unreachable: ClassifiedReference[] = [];
    const referenced: MemberReference[] = [];
    for (const use of uses) {
      const qualifier = qualifierOf(use.node);
      const symbol = qualifier ? checker.getSymbolAtLocation(qualifier.expression) : undefined;
      if (
        !qualifier ||
        symbol === undefined ||
        containerSymbol === undefined ||
        unalias(checker, symbol) !== containerSymbol
      ) {
        unreachable.push(use);
        continue;
      }
      const useFile = use.node.getSourceFile();
      const start = qualifier.expression.getStart(useFile);
      referenced.push({ file: use.file, line: use.line, character: use.character });

      if (toModuleScope) {
        // `A.m()` becomes `m()`: the qualifier and its dot go.
        rewrites.push({
          file: path.resolve(useFile.fileName),
          start,
          end: qualifier.nameStart,
          newText: '',
        });
        if (ts.isIdentifier(qualifier.expression)) markDead(qualifier.expression);
        if (!inMember(use.node)) {
          const visible = scopeAt(checker, use.node).get(memberName);
          if (visible !== undefined) {
            throw new Error(
              `"${memberName}" already means something else at ${locationOf(useFile, use.node.getStart(useFile))}, ` +
                'so an unqualified call there would resolve to the wrong thing',
            );
          }
          if (path.resolve(useFile.fileName) !== destination.file) {
            request(path.resolve(useFile.fileName), {
              name: memberName,
              origin: { kind: 'file', file: destination.file },
              form: 'named',
              typeOnly: false,
            });
          }
        }
        continue;
      }

      // `A.m()` becomes `B.m()`, under whatever name B has here.
      const into = destination.class!;
      const intoSymbol = into.name ? checker.getSymbolAtLocation(into.name) : undefined;
      let localName = into.name!.text;
      if (!inMember(use.node)) {
        const scope = scopeAt(checker, use.node);
        const alias = [...scope.entries()].find(
          ([, candidate]) => unalias(checker, candidate) === intoSymbol,
        );
        if (alias) {
          localName = alias[0];
        } else {
          if (scope.has(localName)) {
            throw new Error(
              `"${localName}" already means something else at ${locationOf(useFile, use.node.getStart(useFile))}, ` +
                'so the destination class cannot be named there',
            );
          }
          if (!(ts.getCombinedModifierFlags(into) & ts.ModifierFlags.Export)) {
            throw new Error(
              `${localName} is not exported from ${destination.file}, so ` +
                `${locationOf(useFile, use.node.getStart(useFile))} could not name it`,
            );
          }
          request(path.resolve(useFile.fileName), {
            name: localName,
            origin: { kind: 'file', file: destination.file },
            form: 'named',
            typeOnly: false,
          });
        }
      }
      rewrites.push({
        file: path.resolve(useFile.fileName),
        start,
        end: qualifier.expression.getEnd(),
        newText: localName,
      });
      if (ts.isIdentifier(qualifier.expression)) markDead(qualifier.expression);
    }

    if (unreachable.length > 0) {
      throw new Error(
        `${where} is reached by references this rewrite cannot describe — through a subclass, a ` +
          `namespace object, or a string key:\n  ` +
          unreachable
            .map((use) => `${use.file}:${use.line + 1}:${use.character + 1} (${use.node.parent.getText().slice(0, 60)})`)
            .join('\n  '),
      );
    }

    // A static reached through a computed key is invisible here and to
    // the typecheck alike, so it is reported rather than assumed absent.
    if (containerSymbol !== undefined) {
      const computed = new Set<string>();
      for (const use of classifyReferences(
        session,
        path.resolve(container.getSourceFile().fileName),
        container.name!.getStart(),
      )) {
        const parent = use.node.parent as ts.Node | undefined;
        if (
          parent !== undefined &&
          ts.isElementAccessExpression(parent) &&
          parent.expression === use.node &&
          !ts.isStringLiteralLike(parent.argumentExpression)
        ) {
          computed.add(`${use.file}:${use.line + 1}`);
        }
      }
      if (computed.size > 0) {
        warnings.push(
          `${className} is indexed with a computed key at ${[...computed].join(', ')}; a static ` +
            'reached that way is invisible to both this tool and the typecheck.',
        );
      }
    }

    for (const entry of dependencyImports(session, { member, inMember, destination, where })) {
      request(destination.file, entry);
    }

    // The moved text, with the rewrites that fall inside it applied and
    // its indentation adjusted to its new depth.
    const sourceColumn = columnOf(member, sourceFile);
    const memberSource = sourceFile.text.slice(memberStart, memberEnd);
    const inside = rewrites
      .filter(
        (rewrite) =>
          rewrite.file === path.resolve(sourceFile.fileName) &&
          rewrite.start >= memberStart &&
          rewrite.end <= memberEnd,
      )
      .sort((a, b) => b.start - a.start);
    let moved = memberSource;
    for (const rewrite of inside) {
      moved =
        moved.slice(0, rewrite.start - memberStart) +
        rewrite.newText +
        moved.slice(rewrite.end - memberStart);
    }
    const outside = rewrites.filter((rewrite) => !inside.includes(rewrite));

    if (toModuleScope) {
      const jsDoc = sourceFile.text.slice(memberStart, member.getStart(sourceFile, false)).trimEnd();
      const body = moved.slice(member.getStart(sourceFile, false) - memberStart);
      if (ts.isMethodDeclaration(member)) {
        const isAsync = (modifiers & ts.ModifierFlags.Async) !== 0;
        const signature = body.slice(member.name.getStart(sourceFile) - member.getStart(sourceFile, false));
        moved = `${jsDoc ? `${jsDoc}\n` : ''}export ${isAsync ? 'async ' : ''}function ${member.asteriskToken ? '*' : ''}${signature}`;
      } else {
        const type = member.type ? `: ${member.type.getText(sourceFile)}` : '';
        // Slice forward from the initializer and take everything left:
        // an offset measured before the rewrites no longer describes the
        // end of the text after them.
        const start = member.initializer!.getStart(sourceFile) - memberStart;
        const initializer = moved.slice(start).trimEnd().replace(/;$/, '');
        moved = `${jsDoc ? `${jsDoc}\n` : ''}export const ${memberName}${type} = ${initializer};`;
      }
    }

    const multiline = hasMultilineTemplate(member, sourceFile);
    const targetIndent = destination.class
      ? ' '.repeat(
          destination.class.members[0]
            ? columnOf(destination.class.members[0], destination.class.getSourceFile())
            : columnOf(destination.class, destination.class.getSourceFile()) +
                (formatSettings(session).indentSize ?? 2),
        )
      : '';
    if (multiline) {
      warnings.push(
        `${where} contains a multi-line template literal, whose indentation is string content ` +
          'rather than layout, so the moved code keeps its original indentation.',
      );
    } else {
      moved = reindent(moved, sourceColumn, targetIndent);
    }

    // Edits.
    const changes: Record<string, TextEdit[]> = {};
    const add = (file: string, edit: TextEdit): void => {
      changes[file] = [...(changes[file] ?? []), edit];
    };
    for (const rewrite of outside) {
      const file = session.program().getSourceFile(rewrite.file)!;
      add(rewrite.file, {
        range: {
          start: file.getLineAndCharacterOfPosition(rewrite.start),
          end: file.getLineAndCharacterOfPosition(rewrite.end),
        },
        newText: rewrite.newText,
      });
    }

    const removal = lineSpanOf(member, sourceFile);
    add(path.resolve(sourceFile.fileName), {
      range: {
        start: sourceFile.getLineAndCharacterOfPosition(removal.start),
        end: sourceFile.getLineAndCharacterOfPosition(removal.end),
      },
      newText: '',
    });

    const fileOps: WorkspaceEdit['fileOps'] = [];
    if (destination.created) {
      fileOps.push({ kind: 'create', file: destination.file });
      const zero = { line: 0, character: 0 };
      add(destination.file, { range: { start: zero, end: zero }, newText: `${moved}\n` });
    } else if (destination.class) {
      const into = destination.class;
      const intoFile = into.getSourceFile();
      const last = into.members[into.members.length - 1];
      const offset = last ? last.getEnd() : into.members.end;
      add(destination.file, {
        range: {
          start: intoFile.getLineAndCharacterOfPosition(offset),
          end: intoFile.getLineAndCharacterOfPosition(offset),
        },
        newText: last ? `\n\n${moved}` : `\n${moved}\n`,
      });
    } else {
      const intoFile = session.program().getSourceFile(destination.file)!;
      const end = intoFile.getEnd();
      add(destination.file, {
        range: {
          start: intoFile.getLineAndCharacterOfPosition(end),
          end: intoFile.getLineAndCharacterOfPosition(end),
        },
        newText: `\n${moved}\n`,
      });
    }

    // Imports the move orphans, in the file that lost the member and in
    // every file that no longer names the class it was on. Pruning runs
    // before the pass that adds imports, which needs to know what is
    // about to disappear before it picks somewhere to write.
    const sourceKey = path.resolve(sourceFile.fileName);
    const sourceDead = dead.get(sourceKey) ?? new Set<ts.Node>();
    // Only when the member actually leaves this file. Moving it to
    // another container in the same file relocates the text rather than
    // removing it, and the moved text is raw source the pruning pass
    // cannot see — so counting its names as gone drops an import the
    // relocated code still needs.
    if (destination.file !== sourceKey) {
      for (const node of references(member)) sourceDead.add(node);
    }
    dead.set(sourceKey, sourceDead);
    const pruned = new Map<string, Pruned>();
    for (const [file, nodes] of dead) {
      const owner = session.program().getSourceFile(file);
      if (!owner) continue;
      pruned.set(file, unusedImportEdits(session, owner, nodes));
    }
    for (const [file, requests] of needed) {
      for (const edit of importEdits(session, file, requests, pruned.get(file) ?? NOTHING_PRUNED)) {
        add(file, edit);
      }
    }
    for (const [file, result] of pruned) {
      for (const edit of result.edits) add(file, edit);
    }

    const edit: WorkspaceEdit = fileOps.length > 0 ? { changes, fileOps } : { changes };
    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output = {
      edit,
      filesChanged,
      newDiagnostics,
      warnings,
      references: referenced.sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character,
      ),
    };

    if (input.apply !== true || newDiagnostics.length > 0) return { applied: false, ...output };
    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return { applied: true, ...output };
  },
};
