import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { Position, TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { memberHierarchy } from '../../ast/hierarchy.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { relativeSpecifier, resolvedModuleOf, scopeAt } from '../imports.js';
import { reindent } from '../layout.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences, isUse, type ClassifiedReference } from '../references.js';
import { userPreferences } from '../refactor-action.js';
import { sameBinding, unalias } from '../substitution.js';

/**
 * The god-class split — ReSharper's Extract Class. A chosen subset of a
 * class's members moves into a new class, the original holds one
 * instance of it in a field, and every `this.m()` left behind becomes
 * `this.helper.m()`.
 *
 * **The analysis is the tool; the text motion is the easy half.** A
 * class is a closure over its own state, and a member list drawn through
 * the middle of that closure produces code that either does not compile
 * or — worse — compiles against a second copy of the state. So before
 * any edit exists, every chosen member is asked what it touches, and a
 * chosen member that reads something staying behind is refused by name
 * on both sides. The reverse direction is the supported motion rather
 * than a refusal: a member that stays and reads state that moved is
 * exactly what `this.helper.x` repairs.
 *
 * **The public members are the hard decision, and it is the caller's.**
 * A moved member that was public has callers this class does not
 * contain. Either the original keeps a delegating stub — `delegate:
 * true`, the default, and no call site changes at all — or every
 * external `obj.m()` is rewritten to `obj.helper.m()`, which makes the
 * field part of the public shape. The rewrite is all-or-nothing: one
 * call site the rewrite cannot describe — a destructuring, a string key
 * — refuses the whole thing, because half a rewrite is a class with two
 * spellings for one member.
 *
 * The refusals that are not about the closure are the ones a typecheck
 * would report somewhere unhelpful, or not at all: a `#private` member
 * something left behind still reads (no `this.helper.#x` exists), a
 * member the hierarchy shares (moving one declaration of it strands the
 * others), the constructor (it initialises the whole object, not a
 * subset), and `static` members — which are `ts/refactors/move-member`,
 * a different operation with a different destination shape.
 */

export interface ExtractClassInput {
  /** Class to split, by name. */
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  /** Name of the class to generate. */
  name: string;
  /** Members to move, by name. `#x` matches with or without the hash. */
  members: string[];
  /** Field on the original that holds the instance. Default: name, lower-cased. */
  field?: string;
  /** Module for the new class, existing or created. Default: the class's own file. */
  targetFile?: string;
  /** Keep delegating stubs instead of rewriting call sites. Default true. */
  delegate?: boolean;
  apply?: boolean;
}

export interface ExternalUse {
  file: string;
  line: number;
  character: number;
}

export interface ExtractClassOutput extends RefactorOutput {
  /** Member names moved, in declaration order. */
  members: string[];
  /** Uses of a moved member that do not go through `this`, pre-edit. */
  externalUses: ExternalUse[];
}

/** A class element this tool can move. */
type MovableMember =
  | ts.PropertyDeclaration
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

/** One named member of the class, with every declaration of it. */
interface ClassMember {
  /** As written: a `#name` keeps its hash. */
  name: string;
  declarations: MovableMember[];
  isStatic: boolean;
  isPrivateName: boolean;
}

/** A `this.x` in a member body, and where the receiver ends. */
interface Touch {
  name: string;
  /** The `this` token an internal rewrite inserts the field after. */
  receiver: ts.Node;
  /** The node naming the member, matched against reference offsets. */
  nameNode: ts.Node;
}

interface Usage {
  touches: Touch[];
  /** `this` used as a value: after the move it would be the helper. */
  bareThis: ts.Node[];
  superUses: ts.Node[];
  /** `this[k]` with a key no analysis can read. */
  computed: ts.Node[];
}

/** Where an import has to come from, as the importing file must write it. */
type ImportOrigin = { kind: 'file'; file: string } | { kind: 'package'; text: string };

interface ImportRequest {
  name: string;
  origin: ImportOrigin;
  propertyName?: string;
  form: 'named' | 'default' | 'namespace';
  typeOnly: boolean;
}

interface Span {
  start: number;
  end: number;
}

interface Rewrite {
  file: string;
  sourceFile: ts.SourceFile;
  start: number;
  end: number;
  newText: string;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const OWN_PROPERTY_WARNING =
  'A delegating stub for a data property is a get/set pair, and an accessor lives on the ' +
  'prototype where a field is an own property. That changes what Object.keys, object spread and ' +
  'JSON.stringify see, and nothing in the type system records the difference.';

function isMovableKind(member: ts.ClassElement): member is MovableMember {
  return (
    ts.isPropertyDeclaration(member) ||
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  );
}

/** The written name of a class element, or undefined for a computed one. */
function writtenNameOf(member: ts.ClassElement): string | undefined {
  const name = member.name;
  if (!name) return undefined;
  return ts.isIdentifier(name) || ts.isPrivateIdentifier(name) ? name.text : undefined;
}

function locationOf(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${path.resolve(sourceFile.fileName)}:${line + 1}:${character + 1}`;
}

/**
 * An identifier that refers to something rather than naming it — the
 * set whose meaning is decided by the surrounding scope, and so the set
 * that has to still resolve after the code moves.
 */
function isFreeReference(node: ts.Identifier): boolean {
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

function freeReferences(root: ts.Node): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isFreeReference(node)) found.push(node);
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}

/** What a member body does with `this`. */
function usageOf(root: ts.Node): Usage {
  const usage: Usage = { touches: [], bareThis: [], superUses: [], computed: [] };
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.SuperKeyword) usage.superUses.push(node);
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      const parent = node.parent as ts.Node | undefined;
      if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        usage.touches.push({ name: parent.name.text, receiver: node, nameNode: parent.name });
      } else if (parent && ts.isElementAccessExpression(parent) && parent.expression === node) {
        if (ts.isStringLiteralLike(parent.argumentExpression)) {
          usage.touches.push({
            name: parent.argumentExpression.text,
            receiver: node,
            nameNode: parent.argumentExpression,
          });
        } else {
          usage.computed.push(parent);
        }
      } else {
        usage.bareThis.push(node);
      }
    }
    node.forEachChild(visit);
  };
  visit(root);
  return usage;
}

/**
 * Whole-line spans that remove `nodes` — their own lines, their JSDoc,
 * and the blank line that separated each from what came before.
 *
 * Taking the *preceding* blank rather than the following one keeps the
 * last member of a class from leaving an empty line above the closing
 * brace; a member that opens the body has no preceding blank to take, so
 * those extend forward instead, bounded by the next span so the two can
 * never overlap. `applyTextEdits` rejects overlapping edits, and this
 * tool removes several adjacent members by construction.
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
 * Blank lines a removal span opens and closes with. A span swallows the
 * separators around what it removes, so a replacement has to put them
 * back or the next member welds itself to it.
 */
function blankLinesAround(text: string, span: Span): { before: string; after: string } {
  const lines = text.slice(span.start, span.end).split('\n');
  let before = 0;
  while (before < lines.length - 1 && lines[before]!.trim() === '') before++;
  let after = 0;
  for (let index = lines.length - 2; index > before && lines[index]!.trim() === ''; index--) {
    after++;
  }
  return { before: '\n'.repeat(before), after: '\n'.repeat(after) };
}

/** A statement's whole lines, including the blank line above it. */
function lineSpanOf(node: ts.Node, sourceFile: ts.SourceFile): Span {
  return removalSpans(sourceFile, [node])[0]!;
}

/** Column a node starts at, which is the indent its text assumes. */
function columnOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, true)).character;
}

/** The JSDoc block above a declaration, verbatim. */
function docCommentOf(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  return sourceFile
    .getFullText()
    .slice(node.getStart(sourceFile, true), node.getStart(sourceFile, false))
    .trim();
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
 * Import statements binding `requests` in `fromFile`, one statement per
 * module. Named requests for the same module share a clause, with a
 * type-only one written inline — a file that grows two imports of one
 * module for want of grouping reads as a defect in the tool.
 */
function importBlock(
  session: TsProjectSession,
  fromFile: string,
  requests: readonly ImportRequest[],
): string {
  const preferences = userPreferences(session);
  const quote = preferences.quotePreference === 'double' ? '"' : "'";
  const specifierOf = (origin: ImportOrigin): string =>
    origin.kind === 'package'
      ? origin.text
      : relativeSpecifier(fromFile, origin.file, preferences.importModuleSpecifierEnding === 'js');
  const aliasOf = (request: ImportRequest): string =>
    request.propertyName && request.propertyName !== request.name
      ? `${request.propertyName} as ${request.name}`
      : request.name;

  const lines: string[] = [];
  const grouped = new Map<string, ImportRequest[]>();
  for (const request of requests) {
    if (request.form !== 'named') {
      const clause = request.form === 'namespace' ? `* as ${request.name}` : request.name;
      lines.push(
        `import ${request.typeOnly ? 'type ' : ''}${clause} from ${quote}${specifierOf(request.origin)}${quote};`,
      );
      continue;
    }
    const key = specifierOf(request.origin);
    grouped.set(key, [...(grouped.get(key) ?? []), request]);
  }
  for (const [specifier, group] of grouped) {
    const allTypeOnly = group.every((request) => request.typeOnly);
    const names = group.map((request) =>
      request.typeOnly && !allTypeOnly ? `type ${aliasOf(request)}` : aliasOf(request),
    );
    lines.push(
      `import ${allTypeOnly ? 'type ' : ''}{ ${names.join(', ')} } from ${quote}${specifier}${quote};`,
    );
  }
  return lines.join('\n');
}

/**
 * What the pruning pass took out of a file, so the pass that adds
 * imports does not anchor an insertion inside a deletion — a pair
 * `applyTextEdits` rejects as overlapping.
 */
/**
 * The import repair one file needs: bindings the moved code took with it
 * removed, bindings the file now needs added — in one pass over the
 * import declarations.
 *
 * One pass rather than two, because the two edit the same characters. A
 * file that imported `{ round, Money }` to reach a member that just left
 * loses `round` and gains `Pricing`; a removal that rewrites the clause
 * and an insertion anchored inside it are two edits over one span, which
 * `applyTextEdits` rejects. So a clause that both loses and gains a name
 * is rewritten once, whole.
 *
 * `dead` is the set of identifier nodes that are leaving. An empty set
 * means nothing is pruned and this only adds.
 */
function importRepairEdits(
  session: TsProjectSession,
  file: string,
  requests: readonly ImportRequest[],
  dead: ReadonlySet<ts.Node>,
): TextEdit[] {
  const sourceFile = session.program().getSourceFile(file);
  if (!sourceFile) {
    // A file the edit creates: its whole text is one insertion at 0:0.
    const zero = { line: 0, character: 0 };
    const text = importBlock(session, file, requests);
    return text === '' ? [] : [{ range: { start: zero, end: zero }, newText: `${text}\n\n` }];
  }

  const checker = session.checker();
  const at = (offset: number): Position => sourceFile.getLineAndCharacterOfPosition(offset);
  const edits: TextEdit[] = [];
  const orphans = new Set<ts.ImportSpecifier>();

  if (dead.size > 0) {
    const live = new Set<ts.Symbol>();
    // `export { A }` with no module specifier refers to the local
    // binding through a symbol of its own, so it is matched by name.
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
      if (ts.isIdentifier(node) && isFreeReference(node) && !dead.has(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol) live.add(symbol);
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);

    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        const symbol = checker.getSymbolAtLocation(element.name);
        if (symbol !== undefined && !live.has(symbol) && !reExported.has(element.name.text)) {
          orphans.add(element);
        }
      }
    }
  }

  const pending = [...requests];
  const displaced: ts.ImportDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const survivors = bindings.elements.filter((element) => !orphans.has(element));
    const moduleFile = resolvedModuleOf(statement, session.program().getCompilerOptions());
    const absorbed = pending.filter(
      (request) =>
        request.form === 'named' &&
        request.origin.kind === 'file' &&
        request.origin.file === moduleFile &&
        (!clause.isTypeOnly || request.typeOnly),
    );
    if (survivors.length === bindings.elements.length && absorbed.length === 0) continue;
    for (const request of absorbed) pending.splice(pending.indexOf(request), 1);

    const written = [
      ...survivors.map((element) => element.getText(sourceFile)),
      ...absorbed.map((request) => {
        const alias =
          request.propertyName && request.propertyName !== request.name
            ? `${request.propertyName} as ${request.name}`
            : request.name;
        return request.typeOnly && !clause.isTypeOnly ? `type ${alias}` : alias;
      }),
    ];
    if (written.length > 0) {
      edits.push({
        range: { start: at(bindings.getStart(sourceFile)), end: at(bindings.getEnd()) },
        newText: `{ ${written.join(', ')} }`,
      });
      continue;
    }
    if (clause.name) {
      // `import Default, { gone }` — the default binding stays.
      edits.push({ range: { start: at(clause.name.getEnd()), end: at(bindings.getEnd()) }, newText: '' });
      continue;
    }
    const span = lineSpanOf(statement, sourceFile);
    edits.push({ range: { start: at(span.start), end: at(span.end) }, newText: '' });
    displaced.push(statement);
  }

  if (pending.length === 0) return edits;
  const text = importBlock(session, file, pending);
  const imports = sourceFile.statements
    .filter(ts.isImportDeclaration)
    .filter((statement) => !displaced.includes(statement));
  const last = imports[imports.length - 1];
  if (last) {
    edits.push({ range: { start: at(last.getEnd()), end: at(last.getEnd()) }, newText: `\n${text}` });
  } else if (displaced[0]) {
    // Every import this file had is going: the new block takes the
    // vacated lines, so the blank line that followed them is still the
    // one blank line between imports and code.
    const start = lineSpanOf(displaced[0], sourceFile).start;
    edits.push({ range: { start: at(start), end: at(start) }, newText: `${text}\n` });
  } else {
    const first = sourceFile.statements[0];
    const start = first ? first.getStart(sourceFile, true) : 0;
    edits.push({ range: { start: at(start), end: at(start) }, newText: `${text}\n\n` });
  }
  return edits;
}


export const extractClass: Tool<ExtractClassInput, ExtractClassOutput, TsProjectSession> = {
  name: 'ts/refactors/extract-class',
  description:
    "The god-class split — ReSharper's Extract Class. Moves the members named in `members` out " +
    'of a class into a new one, holds an instance of it in a field on the original, and rewrites ' +
    'every `this.m()` left behind to `this.<field>.m()`. The analysis is the tool: a chosen ' +
    'member that reads state staying behind cuts the class in two, and is refused by name on ' +
    'both sides before any edit is built. What happens to external callers is the caller\'s ' +
    'decision — delegate: true (the default) keeps a delegating stub on the original so no call ' +
    'site changes at all, while delegate: false rewrites every external obj.m() to ' +
    'obj.<field>.m() and makes the field public. That rewrite is all-or-nothing: one use it ' +
    'cannot describe — a destructuring, a string key, a detached reference — refuses the whole ' +
    'split. targetFile puts the new class in another module, existing or created, with the ' +
    'imports the moved code needs; the default is the class\'s own file. Refuses a static member ' +
    '(that is ts/refactors/move-member), the constructor, a member a base class or subclass also ' +
    'declares, a #private member something left behind still reads, and a decorated or abstract ' +
    'member. Dry-run by default; apply: true writes to disk unless the typecheck reports ' +
    'newDiagnostics.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      symbol: { type: 'string', description: 'Class to split' },
      name: { type: 'string', description: 'Name of the class to generate' },
      members: {
        type: 'array',
        items: { type: 'string' },
        description: 'Members to move, by name (#x matches with or without the hash)',
      },
      field: {
        type: 'string',
        description: 'Field on the original holding the instance (default: name, lower-cased)',
      },
      targetFile: {
        type: 'string',
        description:
          'Module for the new class, existing or created, relative to the project root ' +
          "(default: the class's own file)",
      },
      delegate: {
        type: 'boolean',
        description:
          'Keep a delegating stub on the original for every moved member with external uses ' +
          '(default true). false rewrites those call sites to obj.<field>.m() instead.',
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    required: ['name', 'members'],
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      members: { type: 'array', items: { type: 'string' } },
      externalUses: {
        type: 'array',
        description: 'Uses of a moved member that do not go through `this`, in the pre-edit tree',
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
    ['members', 'externalUses'],
  ),

  async run(session, input) {
    const checker = session.checker();
    const warnings: string[] = [];
    const delegate = input.delegate !== false;

    if (!IDENTIFIER.test(input.name)) throw new Error(`"${input.name}" is not a legal class name`);
    if (!Array.isArray(input.members) || input.members.length === 0) {
      throw new Error('members must name at least one member to move');
    }

    // ---- the class -------------------------------------------------
    const target = resolveTarget(session, input);
    const declaration = declarationAt(target);
    if (!ts.isClassDeclaration(declaration)) {
      throw new Error(
        `Extract Class targets a class; the declaration here is a ${ts.SyntaxKind[declaration.kind]}`,
      );
    }
    const classDeclaration = declaration;
    if (!classDeclaration.name) throw new Error('An anonymous class has no name to split');
    const className = classDeclaration.name.text;
    if (className === input.name) {
      throw new Error(`The new class cannot be called "${input.name}" too — that is the class`);
    }
    const classSource = classDeclaration.getSourceFile();
    if (classSource.isDeclarationFile) {
      throw new Error(`${className} is declared in a .d.ts file, which this tool does not rewrite`);
    }
    const classFile = path.resolve(classSource.fileName);

    // ---- the member index ------------------------------------------
    const index = new Map<string, ClassMember>();
    const unnamed: ts.ClassElement[] = [];
    for (const element of classDeclaration.members) {
      if (ts.isConstructorDeclaration(element)) continue;
      if (!isMovableKind(element)) {
        unnamed.push(element);
        continue;
      }
      const name = writtenNameOf(element);
      if (name === undefined) {
        unnamed.push(element);
        continue;
      }
      const existing = index.get(name);
      if (existing) existing.declarations.push(element);
      else {
        index.set(name, {
          name,
          declarations: [element],
          isStatic: (ts.getCombinedModifierFlags(element) & ts.ModifierFlags.Static) !== 0,
          isPrivateName: name.startsWith('#'),
        });
      }
    }

    const lookup = (requested: string): ClassMember | undefined => {
      const exact = index.get(requested);
      if (exact) return exact;
      const wanted = requested.startsWith('#') ? requested.slice(1) : `#${requested}`;
      return index.get(wanted);
    };

    const moved: ClassMember[] = [];
    for (const requested of input.members) {
      if (requested === 'constructor') {
        throw new Error(
          `The constructor initialises the whole object, not a subset of it, so it cannot move ` +
            `into ${input.name}. Move the members it assigns and let the constructor keep ` +
            'assigning them through the field.',
        );
      }
      const member = lookup(requested);
      if (!member) {
        const available = [...index.keys()].join(', ');
        throw new Error(
          `${className} declares no member named "${requested}". Available: ${available || '(none)'}` +
            '. An inherited member is not offered: its declaration lives on the base class, and ' +
            'moving it from here would move nothing.',
        );
      }
      if (moved.includes(member)) continue;
      if (member.isStatic) {
        throw new Error(
          `${className}.${member.name} is static. A static member is not part of the instance's ` +
            'state, so extracting it into an instance held by a field is not what it needs — ' +
            'ts/refactors/move-member moves a static to another class or demotes it to a ' +
            'module-level binding.',
        );
      }
      moved.push(member);
    }
    // Declaration order, not the order `members` listed them in: the new
    // class should read the way the old one did.
    moved.sort((a, b) => a.declarations[0]!.getStart() - b.declarations[0]!.getStart());
    const movedNames = new Set(moved.map((member) => member.name));
    const movedDeclarations = moved.flatMap((member) => member.declarations);

    for (const member of moved) {
      for (const element of member.declarations) {
        const where = `${className}.${member.name}`;
        if ((ts.getDecorators(element) ?? []).length > 0) {
          throw new Error(`${where} is decorated, and the decorator does not travel with it`);
        }
        const flags = ts.getCombinedModifierFlags(element);
        if (flags & (ts.ModifierFlags.Abstract | ts.ModifierFlags.Ambient)) {
          throw new Error(`${where} is abstract or ambient: there is no implementation to move`);
        }
        if (flags & ts.ModifierFlags.Override) {
          throw new Error(`${where} is an override, so its declaration is shared with a base class`);
        }
      }

      // A member the hierarchy shares is not the only declaration of
      // itself: moving one leaves the others behind, still satisfying
      // the contract this split was meant to break up.
      const hierarchy = memberHierarchy(session, member.declarations[0]!);
      if (hierarchy.unresolved.length > 0) {
        throw new Error(
          `${className}'s hierarchy cannot be resolved (${hierarchy.unresolved.join(', ')}), so ` +
            `another declaration of "${member.name}" could be invisible here`,
        );
      }
      if (hierarchy.supertypes.length + hierarchy.subtypes.length > 0) {
        const others = [...hierarchy.supertypes, ...hierarchy.subtypes]
          .map((other) => `${other.container} (${other.file}:${other.line + 1})`)
          .join(', ');
        throw new Error(
          `${className}.${member.name} is also declared by ${others}; moving one declaration of a ` +
            'shared member leaves the others behind, and the hierarchy stops agreeing about what ' +
            'it means',
        );
      }
    }

    // ---- the closure -----------------------------------------------
    //
    // The whole difficulty of this refactoring: the chosen set has to be
    // closed under "reads". A moved member that reads something staying
    // behind has no way to reach it, and there is no back-pointer to
    // give it. The reverse direction is the operation itself.
    const cuts: string[] = [];
    for (const member of moved) {
      for (const element of member.declarations) {
        const usage = usageOf(element);
        const where = `${className}.${member.name}`;
        if (usage.superUses.length > 0) {
          throw new Error(
            `${where} uses \`super\`, which names ${className}'s base class. ${input.name} does ` +
              'not extend it, so the call would have nothing to resolve against.',
          );
        }
        if (usage.bareThis.length > 0) {
          throw new Error(
            `${where} uses \`this\` as a value (${locationOf(usage.bareThis[0]!)}), which after ` +
              `the move is the ${input.name} instance rather than the ${className} it is today. ` +
              'Nothing about that changes what compiles, so it is refused rather than warned about.',
          );
        }
        if (usage.computed.length > 0) {
          throw new Error(
            `${where} reads \`${usage.computed[0]!.getText(classSource)}\` — a member reached ` +
              'through a computed key, which neither this analysis nor the typecheck can follow ' +
              'to decide whether it moves',
          );
        }
        for (const touch of usage.touches) {
          if (movedNames.has(touch.name)) continue;
          cuts.push(`${member.name} reads this.${touch.name}`);
        }
      }
    }
    if (cuts.length > 0) {
      const stranded = [...new Set(cuts)];
      throw new Error(
        `The split cuts a dependency: ${stranded.join(', ')}. A moved member cannot reach state ` +
          `that stays on ${className} — there is no back-reference, and adding one would make ` +
          `${input.name} and ${className} mutually dependent. Either add ` +
          `${[...new Set(cuts.map((cut) => cut.slice(cut.indexOf('this.') + 5)))]
            .map((name) => `"${name}"`)
            .join(', ')} to members, or leave the reading member behind.`,
      );
    }

    // Touches from what stays behind, which is what `this.<field>.` is
    // for. Statics are excluded: `this` in a static member is the class,
    // so it can never name an instance member that moved.
    const internalRewrites: Touch[] = [];
    const touchedFromOriginal = new Set<string>();
    const internalOffsets = new Set<number>();
    let computedFromOriginal = false;
    for (const element of classDeclaration.members) {
      // `this` in a static member — or a static block — is the class
      // object, so it can never name an instance member that moved.
      if (ts.getCombinedModifierFlags(element) & ts.ModifierFlags.Static) continue;
      if (ts.isClassStaticBlockDeclaration(element)) continue;
      const isMoved = movedDeclarations.includes(element as MovableMember);
      const usage = usageOf(element);
      for (const touch of usage.touches) {
        internalOffsets.add(touch.nameNode.getStart(classSource));
        if (isMoved || !movedNames.has(touch.name)) continue;
        internalRewrites.push(touch);
        touchedFromOriginal.add(touch.name);
      }
      if (!isMoved && usage.computed.length > 0) computedFromOriginal = true;
    }
    if (computedFromOriginal) {
      warnings.push(
        `${className} reads a member through a computed key (this[k]); if that key ever names a ` +
          'moved member the read is now on the wrong object, and neither this tool nor the ' +
          'typecheck can see it.',
      );
    }

    // ---- uses that do not go through `this` ------------------------
    const movedSpans = movedDeclarations.map((element) => ({
      start: element.getStart(classSource, true),
      end: element.getEnd(),
    }));
    const insideMoved = (reference: ClassifiedReference): boolean =>
      reference.file === classFile &&
      movedSpans.some((span) => reference.offset >= span.start && reference.offset < span.end);

    const externalByMember = new Map<string, ClassifiedReference[]>();
    const seenReference = new Set<string>();
    for (const member of moved) {
      const collected: ClassifiedReference[] = [];
      for (const element of member.declarations) {
        for (const reference of classifyReferences(
          session,
          classFile,
          element.name.getStart(classSource),
        )) {
          if (!isUse(reference)) continue;
          if (reference.file === classFile && internalOffsets.has(reference.offset)) continue;
          const key = `${reference.file}:${reference.offset}`;
          if (seenReference.has(key)) continue;
          seenReference.add(key);
          if (insideMoved(reference)) {
            throw new Error(
              `${className}.${member.name} is reached at ${locationOf(reference.node)} through ` +
                'another instance rather than through `this`, from inside a member that is ' +
                'moving. The moved code would keep naming the member on ' +
                `${className}, which no longer declares it.`,
            );
          }
          collected.push(reference);
        }
      }
      externalByMember.set(member.name, collected);
    }
    const externalUses: ExternalUse[] = [...externalByMember.values()]
      .flat()
      .map((reference) => ({
        file: reference.file,
        line: reference.line,
        character: reference.character,
      }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character);

    // A `#name` is reachable only inside the body that declares it, so
    // `this.<field>.#x` does not exist as syntax. A #private member can
    // move, but only when everything that reads it moves too.
    for (const member of moved) {
      if (!member.isPrivateName) continue;
      const readers = [
        ...(touchedFromOriginal.has(member.name)
          ? [`members of ${className} that are staying behind`]
          : []),
        ...(externalByMember.get(member.name) ?? []).map((reference) => locationOf(reference.node)),
      ];
      if (readers.length === 0) continue;
      throw new Error(
        `${className}.${member.name} is a #private member, and ${readers.join(', ')} still read ` +
          `it. A #name is reachable only inside the class body that declares it, so there is no ` +
          `this.<field>.${member.name} to rewrite those reads into. Move every member that reads ` +
          'it too, or make it a private field first.',
      );
    }

    // ---- the field --------------------------------------------------
    const fieldName =
      input.field ?? `${input.name.charAt(0).toLowerCase()}${input.name.slice(1)}`;
    if (!IDENTIFIER.test(fieldName)) {
      throw new Error(`"${fieldName}" is not a legal field name`);
    }
    if (index.has(fieldName) && !movedNames.has(fieldName)) {
      throw new Error(
        `${className} already declares "${fieldName}", so the field holding the ${input.name} ` +
          'cannot take that name. Pass field.',
      );
    }

    // ---- where the new class goes -----------------------------------
    const destinationFile =
      input.targetFile === undefined ? classFile : path.resolve(session.rootPath, input.targetFile);
    if (ts.sys.directoryExists(destinationFile)) {
      throw new Error(`Destination ${destinationFile} is a directory, not a file`);
    }
    const destinationSource = session.program().getSourceFile(destinationFile);
    const createsDestination = destinationSource === undefined;
    const destinationScope =
      destinationSource === undefined
        ? new Map<string, ts.Symbol>()
        : scopeAt(
            checker,
            destinationSource.statements[destinationSource.statements.length - 1] ?? destinationSource,
          );
    if (destinationScope.has(input.name)) {
      throw new Error(`"${input.name}" already means something else in ${destinationFile}`);
    }
    const classScope = scopeAt(checker, classDeclaration);
    if (destinationFile !== classFile && classScope.has(input.name)) {
      throw new Error(
        `"${input.name}" already means something else in ${classFile}, so the class file cannot ` +
          'import the new class under that name',
      );
    }

    // ---- delegating stubs, or a call-site rewrite --------------------
    const needsReaching = new Set<string>(touchedFromOriginal);
    const externalRewrites: Rewrite[] = [];
    const stubs: { anchor: number; text: string }[] = [];

    if (!delegate) {
      const unreachable: string[] = [];
      for (const [name, references] of externalByMember) {
        for (const reference of references) {
          const parent = reference.node.parent as ts.Node | undefined;
          if (
            !parent ||
            !ts.isPropertyAccessExpression(parent) ||
            parent.name !== reference.node ||
            parent.questionDotToken !== undefined
          ) {
            unreachable.push(
              `${reference.file}:${reference.line + 1}:${reference.character + 1} (${reference.kind}: ` +
                `${(parent ?? reference.node).getText().slice(0, 48).replace(/\s+/g, ' ')})`,
            );
            continue;
          }
          const useFile = reference.node.getSourceFile();
          externalRewrites.push({
            file: path.resolve(useFile.fileName),
            sourceFile: useFile,
            start: parent.expression.getEnd(),
            end: parent.expression.getEnd(),
            newText: `.${fieldName}`,
          });
          needsReaching.add(name);
        }
      }
      if (unreachable.length > 0) {
        throw new Error(
          `delegate: false rewrites every external use to obj.${fieldName}.<member>, and these ` +
            'cannot be written that way — a destructuring, a string key, or a reference held as ' +
            `a value:\n  ${unreachable.join('\n  ')}\nThe rewrite is all-or-nothing: a class ` +
            'with two spellings for one member is worse than an unsplit one. Run with delegate: ' +
            'true to keep a delegating stub instead.',
        );
      }
      if (externalRewrites.length > 0) {
        warnings.push(
          `The field "${fieldName}" is public, because ${externalRewrites.length} call site(s) now ` +
            `spell obj.${fieldName}.<member>. ${input.name} is part of ${className}'s public ` +
            'shape from here on.',
        );
      }
    } else {
      for (const member of moved) {
        const references = externalByMember.get(member.name) ?? [];
        if (references.length === 0) continue;
        needsReaching.add(member.name);
        stubs.push({
          anchor: member.declarations[0]!.getStart(classSource, true),
          text: stubFor(session, member, fieldName, className, warnings),
        });
      }
    }

    // ---- the moved text ----------------------------------------------
    const memberIndent = classDeclaration.members[0]
      ? ' '.repeat(columnOf(classDeclaration.members[0], classSource))
      : '  ';
    const widened: string[] = [];
    const movedTexts: string[] = [];
    for (const member of moved) {
      for (const element of member.declarations) {
        const start = element.getStart(classSource, true);
        let text = classSource.text.slice(start, element.getEnd());

        // A member the original still has to reach cannot keep its
        // accessibility: `this.<field>.x` is a read from a different
        // class, and `private` there is TS2341 rather than a design.
        if (needsReaching.has(member.name)) {
          const accessibility = (ts.getModifiers(element) ?? []).find(
            (modifier) =>
              modifier.kind === ts.SyntaxKind.PrivateKeyword ||
              modifier.kind === ts.SyntaxKind.ProtectedKeyword,
          );
          if (accessibility) {
            const modifiers = ts.getModifiers(element) ?? [];
            const next = modifiers[modifiers.indexOf(accessibility) + 1] ?? element.name;
            text =
              text.slice(0, accessibility.getStart(classSource) - start) +
              text.slice(next.getStart(classSource) - start);
            widened.push(`${member.name} (${ts.tokenToString(accessibility.kind)})`);
          }
        }

        if (hasMultilineTemplate(element, classSource)) {
          warnings.push(
            `${className}.${member.name} contains a multi-line template literal, whose ` +
              'indentation is string content rather than layout, so the moved code keeps its ' +
              'original indentation.',
          );
          movedTexts.push(text);
        } else {
          movedTexts.push(reindent(text, columnOf(element, classSource), '  '));
        }
      }
    }
    if (widened.length > 0) {
      warnings.push(
        `${widened.join(', ')} lost its accessibility modifier in ${input.name}: ${className} ` +
          'reaches it through the field, which is a read from a different class. It is now ' +
          `visible to everything that can reach a ${input.name}.`,
      );
    }

    const exported =
      destinationFile !== classFile ||
      (ts.getCombinedModifierFlags(classDeclaration) & ts.ModifierFlags.Export) !== 0;
    const newClassText = `${exported ? 'export ' : ''}class ${input.name} {\n${movedTexts.join('\n\n')}\n}`;

    // ---- imports the new class needs ---------------------------------
    const requests = new Map<string, ImportRequest[]>();
    const requestImport = (file: string, request: ImportRequest): void => {
      const list = requests.get(file) ?? [];
      if (!list.some((other) => other.name === request.name)) list.push(request);
      requests.set(file, list);
    };
    if (destinationFile !== classFile) {
      for (const request of dependencyImports(
        session,
        movedDeclarations,
        destinationFile,
        destinationScope,
        className,
      )) {
        requestImport(destinationFile, request);
      }
      requestImport(classFile, {
        name: input.name,
        origin: { kind: 'file', file: destinationFile },
        form: 'named',
        typeOnly: false,
      });
    }

    // ---- edits --------------------------------------------------------
    const changes: Record<string, TextEdit[]> = {};
    const add = (file: string, edit: TextEdit): void => {
      changes[file] = [...(changes[file] ?? []), edit];
    };
    const rangeIn = (sourceFile: ts.SourceFile, start: number, end: number) => ({
      start: sourceFile.getLineAndCharacterOfPosition(start),
      end: sourceFile.getLineAndCharacterOfPosition(end),
    });

    for (const touch of internalRewrites) {
      const end = touch.receiver.getEnd();
      add(classFile, { range: rangeIn(classSource, end, end), newText: `.${fieldName}` });
    }
    for (const rewrite of externalRewrites) {
      add(rewrite.file, {
        range: rangeIn(rewrite.sourceFile, rewrite.start, rewrite.end),
        newText: rewrite.newText,
      });
    }

    const brace = classDeclaration
      .getChildren(classSource)
      .find((child) => child.kind === ts.SyntaxKind.OpenBraceToken);
    if (!brace) throw new Error(`${className} has no class body to hold the field`);

    const spans = removalSpans(classSource, movedDeclarations);
    if (spans[0]!.start < brace.getEnd()) {
      throw new Error(
        `${className} writes a moved member on the same line as its opening brace, so removing it ` +
          'and inserting the field would be two edits over one span. Put the member on its own ' +
          'line and run again.',
      );
    }
    const stubText = stubs
      .sort((a, b) => a.anchor - b.anchor)
      .map((stub) => reindent(stub.text, 0, memberIndent))
      .join('\n\n');
    for (const [position, span] of spans.entries()) {
      const blanks = blankLinesAround(classSource.getFullText(), span);
      const first = position === 0 && stubText !== '';
      add(classFile, {
        range: rangeIn(classSource, span.start, span.end),
        newText: first ? `${blanks.before}${stubText}\n${blanks.after}` : '',
      });
    }

    // The field goes immediately after the class body's `{` rather than
    // where the first moved member was: a field initializer runs in
    // declaration order, so a surviving `private cache = this.m()` that
    // this rewrite turns into `this.<field>.m()` would read an
    // undefined field if the field were declared below it — a runtime
    // break with nothing for the typecheck to report.
    const fieldIsPublic = !delegate && externalRewrites.length > 0;
    const fieldDeclaration =
      `${fieldIsPublic ? '' : 'private '}readonly ${fieldName} = new ${input.name}();`;
    // The blank line after the field separates it from what follows.
    // When nothing follows — every member moved — that separator is the
    // whole gap left above the closing brace, so it is dropped instead.
    const closingBrace = classDeclaration
      .getChildren(classSource)
      .findLast((child) => child.kind === ts.SyntaxKind.CloseBraceToken);
    let surviving = '';
    let cursor = brace.getEnd();
    for (const span of spans) {
      surviving += classSource.text.slice(cursor, span.start);
      cursor = span.end;
    }
    surviving += classSource.text.slice(
      cursor,
      closingBrace ? closingBrace.getStart(classSource) : classDeclaration.getEnd(),
    );
    const bodyEmptied = surviving.trim() === '' && stubText === '';
    add(classFile, {
      range: rangeIn(classSource, brace.getEnd(), brace.getEnd()),
      newText: `\n${memberIndent}${fieldDeclaration}${bodyEmptied ? '' : '\n'}`,
    });

    const fileOps: WorkspaceEdit['fileOps'] = [];
    if (createsDestination) {
      fileOps.push({ kind: 'create', file: destinationFile });
      const header = importBlock(session, destinationFile, requests.get(destinationFile) ?? []);
      requests.delete(destinationFile);
      const zero = { line: 0, character: 0 };
      add(destinationFile, {
        range: { start: zero, end: zero },
        newText: `${header === '' ? '' : `${header}\n\n`}${newClassText}\n`,
      });
    } else if (destinationFile === classFile) {
      // Above the class, so the helper is declared before the code that
      // holds one — and above its JSDoc, which belongs to the class.
      let at = classDeclaration.getStart(classSource, true);
      while (at > 0 && classSource.text[at - 1] !== '\n') at--;
      add(classFile, {
        range: rangeIn(classSource, at, at),
        newText: `${newClassText}\n\n`,
      });
    } else {
      const end = destinationSource.getEnd();
      add(destinationFile, {
        range: rangeIn(destinationSource, end, end),
        newText: `\n${newClassText}\n`,
      });
    }

    // Import repair, one pass per file. Only the class file prunes, and
    // only when the moved code left it: moving members within one file
    // relocates the text rather than removing it, and the moved text is
    // raw source this pass cannot see — so counting its names as gone
    // would drop an import the relocated code still needs.
    const dead = new Set<ts.Node>();
    if (destinationFile !== classFile) {
      for (const element of movedDeclarations) {
        for (const node of freeReferences(element)) dead.add(node);
      }
    }
    for (const file of new Set([...requests.keys(), ...(dead.size > 0 ? [classFile] : [])])) {
      for (const edit of importRepairEdits(
        session,
        file,
        requests.get(file) ?? [],
        file === classFile ? dead : new Set<ts.Node>(),
      )) {
        add(file, edit);
      }
    }

    if (delegate) {
      warnings.push(
        `Every moved member with an external use keeps a delegating stub on ${className}, so no ` +
          'call site changed. That is the safe default and it is also the one that leaves the ' +
          `original class holding ${className}'s whole public surface — run with delegate: false ` +
          `to move the callers onto ${input.name} instead.`,
      );
    }

    const edit: WorkspaceEdit = fileOps.length > 0 ? { changes, fileOps } : { changes };
    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output = {
      edit,
      filesChanged,
      newDiagnostics,
      warnings,
      members: moved.map((member) => member.name),
      externalUses,
    };

    if (input.apply !== true || newDiagnostics.length > 0) return { applied: false, ...output };
    session.invalidate(await applyWorkspaceEdit(edit));
    return { applied: true, ...output };
  },
};

/**
 * The delegating stub the original keeps for a moved member that has
 * callers outside it, written at zero indentation for `reindent`.
 *
 * A method forwards its parameters by name, which is why a destructured
 * one is refused: the pattern binds names inside the body and there is
 * nothing to pass on. A data property becomes a `get`/`set` pair, since
 * a field cannot delegate anywhere.
 */
function stubFor(
  session: TsProjectSession,
  member: ClassMember,
  fieldName: string,
  className: string,
  warnings: string[],
): string {
  const where = `${className}.${member.name}`;
  const checker = session.checker();
  const sourceFile = member.declarations[0]!.getSourceFile();
  const doc = docCommentOf(member.declarations[0]!);
  const accessibilityOf = (element: ts.ClassElement): string => {
    const flags = ts.getCombinedModifierFlags(element);
    if (flags & ts.ModifierFlags.Private) return 'private ';
    if (flags & ts.ModifierFlags.Protected) return 'protected ';
    return '';
  };
  const typeTextOf = (element: ts.Declaration, annotation: ts.TypeNode | undefined): string => {
    if (annotation) return annotation.getText(sourceFile);
    const text = checker.typeToString(
      checker.getWidenedType(checker.getTypeAtLocation(element)),
      element,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
    );
    if (text.includes('import(')) {
      throw new Error(
        `${where} has no written type annotation, and the type the checker reports for it ` +
          `(\`${text}\`) contains an absolute \`import("…")\` path — the fallback typeToString ` +
          'uses for a name it cannot resolve here. Annotate the declaration and run again.',
      );
    }
    return text;
  };

  const methods = member.declarations.filter(ts.isMethodDeclaration);
  if (methods.length > 0) {
    if (member.declarations.length > 1) {
      throw new Error(
        `${where} is overloaded, and a delegating stub would have to repeat every signature plus ` +
          'an implementation that fits all of them. Run with delegate: false, or move the ' +
          'callers by hand first.',
      );
    }
    const method = methods[0]!;
    if (method.asteriskToken) {
      throw new Error(
        `${where} is a generator, whose delegation is \`yield*\` rather than \`return\`; this ` +
          'tool does not write that stub. Run with delegate: false.',
      );
    }
    for (const parameter of method.parameters) {
      if (!ts.isIdentifier(parameter.name)) {
        throw new Error(
          `${where} takes a destructured parameter (\`${parameter.name.getText(sourceFile)}\`), ` +
            'whose names are bound inside the body — a stub has nothing to forward. Name the ' +
            'parameter, or run with delegate: false.',
        );
      }
    }
    const flags = ts.getCombinedModifierFlags(method);
    const asyncKeyword = flags & ts.ModifierFlags.Async ? 'async ' : '';
    const typeParameters = method.typeParameters
      ? `<${method.typeParameters.map((parameter) => parameter.getText(sourceFile)).join(', ')}>`
      : '';
    const parameters = method.parameters
      .map((parameter) => parameter.getText(sourceFile))
      .join(', ');
    const returns = method.type ? `: ${method.type.getText(sourceFile)}` : '';
    const args = method.parameters
      .map((parameter) => `${parameter.dotDotDotToken ? '...' : ''}${(parameter.name as ts.Identifier).text}`)
      .join(', ');
    const optional = method.questionToken ? '?' : '';
    return (
      `${doc ? `${doc}\n` : ''}${accessibilityOf(method)}${asyncKeyword}${member.name}${optional}` +
      `${typeParameters}(${parameters})${returns} {\n` +
      `  return this.${fieldName}.${member.name}(${args});\n}`
    );
  }

  const getter = member.declarations.find(ts.isGetAccessorDeclaration);
  const setter = member.declarations.find(ts.isSetAccessorDeclaration);
  const property = member.declarations.find(ts.isPropertyDeclaration);

  const parts: string[] = [];
  if (property) {
    const readonlyProperty =
      (ts.getCombinedModifierFlags(property) & ts.ModifierFlags.Readonly) !== 0;
    const base = typeTextOf(property, property.type);
    const type = property.questionToken ? `${base} | undefined` : base;
    parts.push(
      `${doc ? `${doc}\n` : ''}${accessibilityOf(property)}get ${member.name}(): ${type} {\n` +
        `  return this.${fieldName}.${member.name};\n}`,
    );
    if (!readonlyProperty) {
      parts.push(
        `${accessibilityOf(property)}set ${member.name}(value: ${type}) {\n` +
          `  this.${fieldName}.${member.name} = value;\n}`,
      );
    }
    if (!warnings.includes(OWN_PROPERTY_WARNING)) warnings.push(OWN_PROPERTY_WARNING);
    return parts.join('\n\n');
  }

  if (getter) {
    const type = typeTextOf(getter, getter.type);
    parts.push(
      `${doc ? `${doc}\n` : ''}${accessibilityOf(getter)}get ${member.name}(): ${type} {\n` +
        `  return this.${fieldName}.${member.name};\n}`,
    );
  }
  if (setter) {
    const parameter = setter.parameters[0];
    if (!parameter || !ts.isIdentifier(parameter.name)) {
      throw new Error(`${where}'s setter has no plain parameter to forward`);
    }
    const type = parameter.type
      ? parameter.type.getText(sourceFile)
      : typeTextOf(parameter, undefined);
    parts.push(
      `${getter ? '' : doc ? `${doc}\n` : ''}${accessibilityOf(setter)}set ${member.name}(value: ${type}) {\n` +
        `  this.${fieldName}.${member.name} = value;\n}`,
    );
  }
  if (parts.length === 0) {
    throw new Error(`${where} is a member kind this tool cannot write a delegating stub for`);
  }
  return parts.join('\n\n');
}

/**
 * Imports the destination needs so the moved members still mean what
 * they meant.
 *
 * Every free name in the moved code is re-resolved against the
 * destination's scope. One already bound there to the same symbol needs
 * nothing; one bound to a *different* symbol is a refusal, because that
 * is the failure the guard cannot see — the code compiles and computes
 * something else. A global needs nothing at all: it is declared in a
 * script, so there is no module to import it from.
 */
function dependencyImports(
  session: TsProjectSession,
  movedDeclarations: readonly ts.ClassElement[],
  destinationFile: string,
  destinationScope: ReadonlyMap<string, ts.Symbol>,
  className: string,
): ImportRequest[] {
  const checker = session.checker();
  const requests: ImportRequest[] = [];
  const inMoved = (node: ts.Node): boolean =>
    movedDeclarations.some(
      (element) =>
        node.getSourceFile() === element.getSourceFile() &&
        node.getStart() >= element.getStart() &&
        node.getEnd() <= element.getEnd(),
    );

  for (const element of movedDeclarations) {
    for (const node of freeReferences(element)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol) continue;
      const declarations = symbol.declarations ?? [];
      if (declarations.length > 0 && declarations.every(inMoved)) continue;
      const resolved = unalias(checker, symbol);
      if (!(resolved.declarations ?? []).some((home) => ts.isExternalModule(home.getSourceFile()))) {
        continue;
      }

      const there = destinationScope.get(node.text);
      if (there !== undefined) {
        // `sameBinding`, not identity: for a declaration referenced from
        // its own file, `getSymbolAtLocation` returns the local symbol
        // while `getSymbolsInScope` returns a distinct `ExportValue` one
        // wrapping the same declaration. Comparing identity reports
        // every exported name as "means something different here" — and
        // extracting into a module that declares a type the moved code
        // names is exactly when that happens.
        if (!sameBinding(checker, there, resolved)) {
          throw new Error(
            `"${node.text}" means something different in ${destinationFile}, so the moved code ` +
              'would silently change meaning there',
          );
        }
        continue;
      }
      if (
        declarations.some((home) => path.resolve(home.getSourceFile().fileName) === destinationFile)
      ) {
        continue;
      }
      if (requests.some((request) => request.name === node.text)) continue;

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
          `The moved code reads "${node.text}", which ${path.resolve(home.fileName)} does not ` +
            `export, so ${destinationFile} cannot name it. Export it, or extract into ` +
            `${className}'s own file.`,
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
