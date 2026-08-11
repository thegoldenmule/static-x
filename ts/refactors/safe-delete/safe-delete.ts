import path from 'node:path';
import ts from 'typescript';
import { applyTextEdits, applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { FileOperation, TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { memberHierarchy } from '../../ast/hierarchy.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import { isFrameworkEntry, sourceCandidates } from '../../graph/dead-exports/dead-exports.js';
import { buildImportGraph } from '../../graph/import-graph.js';
import type { TsProjectSession } from '../../project/index.js';
import { isTestFile, toProjectRelative } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { bindingSpanOf } from '../imports.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences, type ClassifiedReference, type ReferenceKind } from '../references.js';

export interface SafeDeleteInput {
  /** Target by declaration name, or by exact position. */
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  /**
   * Whether a reference from a test file keeps the symbol alive.
   * Default false: the tests of a dead symbol are dead too, so their
   * import bindings are removed with it (and a test file left with no
   * statements is deleted). True refuses the deletion instead.
   */
  includeTests?: boolean;
  /** Write the edit to disk. Default false: return the edit only. */
  apply?: boolean;
}

export interface ReferenceSite {
  file: string;
  line: number;
  character: number;
  kind: ReferenceKind;
}

/**
 * `references` is everything the language service found, classified, so
 * the caller can audit the verdict rather than trust it: a deletion
 * happens only when every one of them is the declaration itself, an
 * import binding, or a re-export specifier.
 *
 * `blindSpots` is the part that matters after a clean run. The
 * diagnostics guard proves the remaining code still compiles, which for
 * a deletion is close to proof — a missed reference is TS2304, not a
 * shape change — but it cannot see a reference the language never
 * resolved. Those forms are listed there, every time.
 */
export interface SafeDeleteOutput extends RefactorOutput {
  references: ReferenceSite[];
  blindSpots: string[];
}

/** A half-open [start, end) offset range in one file's text. */
interface Span {
  start: number;
  end: number;
}

/** Kinds that bind or re-export the symbol rather than using it. */
const BINDING: ReadonlySet<ReferenceKind> = new Set<ReferenceKind>([
  'import-binding',
  'export-specifier',
]);

function at(reference: { file: string; line: number; character: number }): string {
  return `${reference.file}:${reference.line + 1}:${reference.character + 1}`;
}

function nameOf(declaration: ts.NamedDeclaration): string {
  const node = declaration.name;
  if (node && (ts.isIdentifier(node) || ts.isPrivateIdentifier(node))) return node.text;
  return node ? node.getText() : '(anonymous)';
}

/**
 * The syntax a deletion removes. Anything smaller than a statement or a
 * class member is a change to a signature or to a type's shape — code
 * that keeps compiling while it stops meaning the same thing — and so
 * belongs to a different refactoring.
 */
function deletionUnit(declaration: ts.NamedDeclaration, name: string): ts.Node {
  if (ts.isParameter(declaration)) {
    throw new Error(
      `"${name}" is a parameter, not a declaration this can delete. Removing a parameter ` +
        'rewrites the signature and every call site, which is ts/refactors/change-signature ' +
        '(not yet built).',
    );
  }
  if (ts.isVariableDeclaration(declaration)) {
    const list = declaration.parent;
    if (!ts.isVariableDeclarationList(list)) {
      throw new Error(
        `"${name}" is a catch-clause binding, not a declaration; safe-delete removes statements ` +
          'and class members.',
      );
    }
    if (list.declarations.length > 1) {
      const others = list.declarations
        .filter((other) => other !== declaration)
        .map((other) => other.name.getText())
        .join(', ');
      throw new Error(
        `"${name}" shares a declaration list with ${others}. Removing one binder means rewriting ` +
          'the statement the others depend on; split the declaration first.',
      );
    }
    if (!ts.isVariableStatement(list.parent)) {
      throw new Error(
        `"${name}" is bound by a ${ts.SyntaxKind[list.parent.kind]} — a loop header, not a ` +
          'declaration statement; safe-delete removes statements and class members.',
      );
    }
    return list.parent;
  }
  if (ts.isTypeElement(declaration) || ts.isEnumMember(declaration)) {
    throw new Error(
      `"${name}" is a member of an interface, type literal, or enum. Removing one changes a ` +
        "type's shape rather than deleting a declaration — every object literal and every " +
        'lookup written against it is affected; safe-delete v1 removes statements and class ' +
        'members.',
    );
  }
  if (ts.isClassElement(declaration)) return declaration;
  const parent = declaration.parent as ts.Node | undefined;
  if (parent && (ts.isSourceFile(parent) || ts.isBlock(parent) || ts.isModuleBlock(parent))) {
    return declaration;
  }
  throw new Error(
    `"${name}" is not a statement or class member (its parent is a ` +
      `${ts.SyntaxKind[parent?.kind ?? ts.SyntaxKind.Unknown]}); safe-delete cannot remove it.`,
  );
}

function lineStartOf(text: string, offset: number): number {
  let start = offset;
  while (start > 0 && text[start - 1] !== '\n') start -= 1;
  // Only take the whole line when nothing else is on it.
  return text.slice(start, offset).trim() === '' ? start : offset;
}

/**
 * Through the end of the line the node ends on, taking a trailing line
 * comment with it — `const x = 1; // why` documents the statement and
 * has nothing left to attach to. Stops at the node when real code
 * follows on the same line.
 */
function lineEndOf(text: string, offset: number): number {
  let end = offset;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end += 1;
  if (text.startsWith('//', end)) {
    while (end < text.length && text[end] !== '\n') end += 1;
  }
  if (text[end] === '\r') end += 1;
  if (text[end] === '\n') return end + 1;
  return end === text.length ? end : offset;
}

/** Start of the blank line immediately before `start`, if there is one. */
function blankLineBefore(text: string, start: number): number | undefined {
  if (start === 0 || text[start - 1] !== '\n') return undefined;
  let lineStart = start - 1;
  while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart -= 1;
  return text.slice(lineStart, start - 1).trim() === '' ? lineStart : undefined;
}

/** End (past the newline) of the blank line at `end`, if there is one. */
function blankLineAfter(text: string, end: number): number | undefined {
  const newline = text.indexOf('\n', end);
  if (newline === -1) return undefined;
  return text.slice(end, newline).trim() === '' ? newline + 1 : undefined;
}

/**
 * The braces the node lives between — a class body, a block, or the
 * file itself. The deletion needs them to tell "last item in its
 * container" from "followed by more code", which is what decides
 * whether a blank line is a separator or a gap between groups.
 */
function containerBounds(node: ts.Node, sourceFile: ts.SourceFile): Span {
  const parent = node.parent as ts.Node | undefined;
  const text = sourceFile.getFullText();
  if (!parent || ts.isSourceFile(parent)) return { start: 0, end: text.length };
  const children = parent.getChildren(sourceFile);
  const open = children.find((child) => child.kind === ts.SyntaxKind.OpenBraceToken);
  const close = children.findLast((child) => child.kind === ts.SyntaxKind.CloseBraceToken);
  if (open && close) return { start: open.getEnd(), end: close.getStart(sourceFile) };
  return { start: parent.getStart(sourceFile), end: parent.getEnd() };
}

/**
 * The span a whole statement or member occupies: its leading JSDoc
 * through the newline that ends it, plus one blank line when the item
 * had one on both sides. Blank lines separate items, so removing an
 * item removes one separator with it — but only one, and only when
 * removing it cannot close the gap between two groups (the last import
 * of a block and the code below it).
 */
function statementSpan(node: ts.Node, sourceFile: ts.SourceFile): Span {
  const text = sourceFile.getFullText();
  const bounds = containerBounds(node, sourceFile);
  let start = lineStartOf(text, node.getStart(sourceFile, /* includeJsDocComment */ true));
  let end = lineEndOf(text, node.getEnd());

  const separatedBefore =
    text.slice(bounds.start, start).trim() === '' || blankLineBefore(text, start) !== undefined;
  const separatedAfter =
    text.slice(end, bounds.end).trim() === '' || blankLineAfter(text, end) !== undefined;
  if (separatedBefore && separatedAfter) {
    const following = blankLineAfter(text, end);
    if (following !== undefined) end = following;
    else {
      const preceding = blankLineBefore(text, start);
      if (preceding !== undefined) start = preceding;
    }
  }
  return { start, end };
}




function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

function toTextEdits(sourceFile: ts.SourceFile, spans: readonly Span[]): TextEdit[] {
  return mergeSpans(spans).map((span) => ({
    range: {
      start: sourceFile.getLineAndCharacterOfPosition(span.start),
      end: sourceFile.getLineAndCharacterOfPosition(span.end),
    },
    newText: '',
  }));
}

interface PackageEntry {
  /** The package.json field naming the file, e.g. `bin["static-x"]`. */
  field: string;
  target: string;
  manifest: string;
}

/** Every string reachable in a package.json "exports" value. */
function collectExportTargets(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const item of node) collectExportTargets(item, out);
  else if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) collectExportTargets(value, out);
  }
}

function entryTargets(pkg: Record<string, unknown>): { field: string; target: string }[] {
  const targets: { field: string; target: string }[] = [];
  for (const field of ['main', 'module', 'types']) {
    const value = pkg[field];
    if (typeof value === 'string') targets.push({ field, target: value });
  }
  if (typeof pkg.bin === 'string') targets.push({ field: 'bin', target: pkg.bin });
  else if (pkg.bin !== null && typeof pkg.bin === 'object') {
    for (const [key, value] of Object.entries(pkg.bin)) {
      if (typeof value === 'string') targets.push({ field: `bin["${key}"]`, target: value });
    }
  }
  const exported: string[] = [];
  collectExportTargets(pkg.exports, exported);
  for (const target of exported) targets.push({ field: 'exports', target });
  return targets;
}

/**
 * The package.json field, if any, that names `file` as an entry point.
 * Same field set and same source-candidate matching as
 * ts/graph/dead-exports, whose exemptions were validated against real
 * projects: what a manifest publishes is consumed by code this project
 * cannot see.
 */
function packageEntryFor(rootPath: string, file: string): PackageEntry | undefined {
  const manifests = ts.sys.readDirectory(rootPath, ['.json'], ['**/node_modules'], [
    '**/package.json',
  ]);
  for (const manifest of manifests) {
    const text = ts.sys.readFile(manifest);
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const packageDir = path.dirname(manifest);
    for (const { field, target } of entryTargets(parsed as Record<string, unknown>)) {
      const candidates = sourceCandidates(packageDir, target);
      if (candidates.some((candidate) => path.resolve(candidate) === file)) {
        return { field, target, manifest: path.resolve(manifest) };
      }
    }
  }
  return undefined;
}

/**
 * Where the symbol's name appears as a string literal. A string key is
 * how a deleted symbol survives every check this tool makes and still
 * breaks at runtime, so the sites are named rather than described.
 */
function literalMentions(
  session: TsProjectSession,
  name: string,
  deleted: ReadonlyMap<string, readonly Span[]>,
): string[] {
  const mentions: string[] = [];
  for (const sourceFile of session.sourceFiles()) {
    const file = path.resolve(sourceFile.fileName);
    const spans = deleted.get(file) ?? [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        node.text === name
      ) {
        const start = node.getStart(sourceFile);
        // A mention inside the deleted text is going away with it.
        if (!spans.some((span) => span.start <= start && start < span.end)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
          mentions.push(at({ file, line, character }));
        }
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  return mentions;
}

export const safeDelete: Tool<SafeDeleteInput, SafeDeleteOutput, TsProjectSession> = {
  name: 'ts/refactors/safe-delete',
  description:
    'Deletes a declaration only after proving nothing references it, and removes what the ' +
    'deletion orphans: its leading JSDoc, import specifiers that bound it, barrel re-export ' +
    'lines, and any file left with no statements (kept, with a warning, when something still ' +
    'imports that file by path). Targets a declaration by name (symbol) or ' +
    'by exact position; this is the removal half of ts/graph/dead-exports. Refuses when any ' +
    'reference is a real use (naming each one), when the symbol is exported from a file a ' +
    'package.json entry field names, when a class member participates in a class hierarchy, ' +
    'and for parameters (a signature change, not a deletion). Dry-run by default; apply: ' +
    'true writes. references lists every reference found, classified. blindSpots names the ' +
    'reference forms TypeScript cannot see — string keys, DI and decorator metadata, ' +
    'framework file-name conventions, package.json paths — so an empty newDiagnostics is ' +
    'never on its own proof that the deletion is safe.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      includeTests: {
        type: 'boolean',
        description:
          'Treat references from *.test.ts / *.spec.ts as uses that block the deletion ' +
          '(default false: they are removed with the symbol)',
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema({
    references: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          character: { type: 'integer' },
          kind: { type: 'string' },
        },
        required: ['file', 'line', 'character', 'kind'],
      },
    },
    blindSpots: { type: 'array', items: { type: 'string' } },
  }),
  async run(session, input) {
    const includeTests = input.includeTests ?? false;
    const target = resolveTarget(session, input);
    const declaration = declarationAt(target);
    const name = nameOf(declaration);
    const unit = deletionUnit(declaration, name);
    const targetFile = path.resolve(target.file);
    const sourceFile = target.sourceFile;

    if (ts.isClassElement(unit)) {
      const hierarchy = memberHierarchy(session, declaration);
      if (hierarchy.unresolved.length > 0) {
        throw new Error(
          `"${name}" belongs to a class whose hierarchy cannot be resolved (${hierarchy.unresolved.join('; ')}). ` +
            'A mixin or unresolved base class hides the other declarations of this member, so ' +
            'the deletion cannot be proven safe.',
        );
      }
      const related = [...hierarchy.supertypes, ...hierarchy.subtypes];
      if (related.length > 0) {
        throw new Error(
          `"${name}" is one declaration of a member shared with ${related
            .map((member) => `${member.container} at ${at(member)}`)
            .join(', ')}. Deleting it changes which implementation runs without changing what ` +
            'compiles, so it is refused.',
        );
      }
    }

    const targetSpan = statementSpan(unit, sourceFile);
    const references = classifyReferences(session, targetFile, target.offset);
    const inTargetSpan = (reference: ClassifiedReference): boolean =>
      reference.file === targetFile &&
      reference.offset >= targetSpan.start &&
      reference.offset < targetSpan.end;

    // Exported through a modifier, or through an `export { name }` the
    // deletion will have to unbind — either way the name is reachable
    // from outside the file it lives in.
    const exported =
      (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) !== 0 ||
      references.some((reference) => reference.kind === 'export-specifier');
    if (exported) {
      const entry = packageEntryFor(session.rootPath, targetFile);
      if (entry) {
        throw new Error(
          `"${name}" is exported from ${toProjectRelative(session.rootPath, targetFile)}, which ` +
            `${toProjectRelative(session.rootPath, entry.manifest)} names in "${entry.field}" ` +
            `("${entry.target}"). Everything an entry point exports is public API consumed by ` +
            'code this project cannot see. Remove the entry point first if the file is really dead.',
        );
      }
    }

    const spans = new Map<string, Span[]>([[targetFile, [targetSpan]]]);
    const addSpan = (file: string, span: Span): void => {
      const existing = spans.get(file);
      if (existing) existing.push(span);
      else spans.set(file, [span]);
    };

    const liveUses: ClassifiedReference[] = [];
    const testBodyUses: ClassifiedReference[] = [];
    const testReferences: ClassifiedReference[] = [];
    const otherDeclarations: ClassifiedReference[] = [];
    for (const reference of references) {
      // A self-reference inside the declaration — recursion, a method
      // naming its own class — dies with the text that contains it.
      if (inTargetSpan(reference)) continue;
      if (reference.kind === 'declaration') {
        otherDeclarations.push(reference);
        continue;
      }
      // With includeTests, a test is code like any other and every
      // reference from one keeps the symbol alive.
      if (includeTests && isTestFile(reference.file)) {
        testReferences.push(reference);
        continue;
      }
      if (!BINDING.has(reference.kind)) {
        (isTestFile(reference.file) ? testBodyUses : liveUses).push(reference);
        continue;
      }
      const span =
        reference.kind === 'import-binding'
          ? bindingSpanOf(reference.node, reference.node.getSourceFile())
          : bindingSpanOf(reference.node, reference.node.getSourceFile());
      if (!span) {
        throw new Error(
          `The ${reference.kind} at ${at(reference)} is not a shape safe-delete can unbind; ` +
            'remove it by hand first.',
        );
      }
      addSpan(reference.file, span);
    }

    if (otherDeclarations.length > 0) {
      throw new Error(
        `"${name}" is declared in more than one place (${otherDeclarations.map(at).join(', ')}) — ` +
          'overloads, or a declaration merge. Deleting one declaration of several leaves the ' +
          'symbol alive with a different meaning, so it is refused.',
      );
    }
    if (liveUses.length > 0) {
      throw new Error(
        `"${name}" is still used at ${liveUses.length} site${liveUses.length === 1 ? '' : 's'}:\n  ` +
          liveUses.map((reference) => `${at(reference)} (${reference.kind})`).join('\n  ') +
          '\nSafe delete removes a declaration only when every reference to it is a binding. ' +
          'Remove these uses first.',
      );
    }
    if (testBodyUses.length > 0) {
      throw new Error(
        `"${name}" is used inside test bodies:\n  ` +
          testBodyUses.map((reference) => `${at(reference)} (${reference.kind})`).join('\n  ') +
          '\nRemoving an it() or describe() block is out of scope for safe-delete: delete the ' +
          'assertions that cover this symbol first, leaving only the import.',
      );
    }
    if (testReferences.length > 0) {
      throw new Error(
        `"${name}" is referenced from tests:\n  ` +
          testReferences.map((reference) => `${at(reference)} (${reference.kind})`).join('\n  ') +
          '\nincludeTests: true counts those as uses. Re-run with includeTests: false (the ' +
          "default) to delete the tests' bindings along with the declaration.",
      );
    }

    const editsByFile = new Map<string, TextEdit[]>();
    const emptied = new Set<string>();
    for (const [file, fileSpans] of spans) {
      const edited = session.program().getSourceFile(file);
      if (!edited) throw new Error(`${file} left the program while computing the deletion`);
      const edits = toTextEdits(edited, fileSpans);
      editsByFile.set(file, edits);
      const remaining = applyTextEdits(edited.getFullText(), edits);
      // A file whose last statement was the deleted one is litter the
      // deletion is responsible for.
      if (ts.createSourceFile(file, remaining, ts.ScriptTarget.Latest, false).statements.length === 0) {
        emptied.add(file);
      }
    }

    // Removing a file something still imports is the one break the
    // guard cannot see: the overlay keeps a deleted file resolvable, so
    // a side-effect import of it typechecks in memory and fails on
    // disk. findReferences could never answer this either — `import
    // './x.js'` and `export * from './x.js'` name no symbol — so the
    // import graph does. An emptied file imports nothing any more, so
    // it cannot be what keeps another one alive.
    const kept = new Map<string, string[]>();
    const removable = new Set(emptied);
    if (emptied.size > 0) {
      const { importers } = buildImportGraph(session);
      for (const file of emptied) {
        const survivors = [...(importers.get(file) ?? [])].filter(
          (importer) => !emptied.has(importer),
        );
        if (survivors.length === 0) continue;
        removable.delete(file);
        kept.set(file, survivors);
      }
    }

    const changes: Record<string, TextEdit[]> = {};
    const fileOps: FileOperation[] = [];
    for (const [file, edits] of editsByFile) {
      if (removable.has(file)) fileOps.push({ kind: 'delete', file });
      else changes[file] = edits;
    }
    const edit: WorkspaceEdit = fileOps.length > 0 ? { changes, fileOps } : { changes };
    const filesChanged = filesTouched(edit);

    const relative = (file: string): string => toProjectRelative(session.rootPath, file);
    const warnings: string[] = [];
    for (const file of removable) {
      warnings.push(
        `Deleted ${relative(file)} entirely: no statements remained after removing "${name}".`,
      );
    }
    for (const [file, survivors] of kept) {
      warnings.push(
        `${relative(file)} has no statements left but is kept: ${survivors
          .map(relative)
          .join(', ')} still imports it by path. Remove that import and the file by hand.`,
      );
    }
    const removedTestBindings = references.filter(
      (reference) => isTestFile(reference.file) && BINDING.has(reference.kind),
    );
    if (removedTestBindings.length > 0) {
      warnings.push(
        `Removed ${removedTestBindings.length} test binding${removedTestBindings.length === 1 ? '' : 's'} ` +
          `(${removedTestBindings.map((reference) => relative(reference.file)).join(', ')}); ` +
          'pass includeTests: true to treat test references as uses instead.',
      );
    }

    const mentions = literalMentions(session, name, spans);
    const blindSpots: string[] = [];
    blindSpots.push(
      mentions.length > 0
        ? `The string "${name}" appears as a literal at ${mentions.join(', ')}. A string-keyed ` +
            `lookup — registry["${name}"], a config value, a serialized command — is not a ` +
            'reference, and nothing here or in the typecheck follows it.'
        : `String-keyed access is invisible to this analysis: registry["${name}"], a key built ` +
            'at runtime, or the name carried in data resolves without ever being a reference.',
    );
    blindSpots.push(
      'Dependency-injection containers, decorator metadata, and reflection bind by token or by ' +
        'emitted type rather than by an identifier the compiler resolves; a provider registered ' +
        'that way looks unreferenced here.',
    );
    if (exported) {
      blindSpots.push(
        `"${name}" is exported. Deleting an export is an API break for everything outside this ` +
          'project — sibling packages, published typings, generated clients, consumers on npm — ' +
          'none of which the in-memory typecheck compiles.',
      );
    }
    for (const file of removable) {
      blindSpots.push(
        `${relative(file)} is deleted, and a file can be named without being imported: ` +
          'framework file-name conventions (app/page.tsx, middleware.ts, *.config.ts), ' +
          'package.json "files"/"scripts" entries, Docker and CI paths.',
      );
    }
    if (isFrameworkEntry(relative(targetFile))) {
      blindSpots.push(
        `${relative(targetFile)} is a framework-convention file, loaded by path rather than by ` +
          'import; a framework may call the deleted export by name.',
      );
    }

    const reported: ReferenceSite[] = references.map((reference) => ({
      file: reference.file,
      line: reference.line,
      character: reference.character,
      kind: reference.kind,
    }));

    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    if (!input.apply || newDiagnostics.length > 0) {
      return {
        applied: false,
        edit,
        filesChanged,
        newDiagnostics,
        warnings,
        references: reported,
        blindSpots,
      };
    }

    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return {
      applied: true,
      edit,
      filesChanged,
      newDiagnostics,
      warnings,
      references: reported,
      blindSpots,
    };
  },
};
