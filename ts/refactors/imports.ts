import path from 'node:path';
import ts from 'typescript';
import type { Position, TextEdit } from '../../core/tool/index.js';

/**
 * The bookkeeping every refactoring that moves or removes a declaration
 * ends up doing: taking the bindings that named it out of the files
 * that no longer do, and writing the ones the code now needs.
 *
 * It is not optional tidying. A specifier left naming something that no
 * longer exists is TS2305, and a file left without one it now needs is
 * TS2304 — both refuse the whole edit at the guard, so a tool that
 * skips this cannot move anything at all. Five tools arrived at the
 * same cases independently before it lived here.
 */

/** Offsets into a file, which is what the compiler APIs speak. */
export interface Span {
  start: number;
  end: number;
}

/**
 * The span that removes one element of a comma-separated list along
 * with the comma joining it to a neighbour.
 *
 * Taking the comma *before* is only possible when there is one, so the
 * first element takes the comma after it instead — which also preserves
 * a trailing comma when the list has one.
 */
export function elementSpanOf(
  element: ts.Node,
  elements: readonly ts.Node[],
  sourceFile: ts.SourceFile,
): Span {
  const index = elements.indexOf(element);
  const previous = index > 0 ? elements[index - 1] : undefined;
  if (previous) return { start: previous.getEnd(), end: element.getEnd() };
  const next = elements[1];
  return {
    start: element.getStart(sourceFile),
    end: next ? next.getStart(sourceFile) : element.getEnd(),
  };
}

/** As elementSpanOf, in the line/character the edit contract speaks. */
export function rangeOfElement(
  element: ts.Node,
  elements: readonly ts.Node[],
  sourceFile: ts.SourceFile,
): { start: Position; end: Position } {
  const span = elementSpanOf(element, elements, sourceFile);
  return {
    start: sourceFile.getLineAndCharacterOfPosition(span.start),
    end: sourceFile.getLineAndCharacterOfPosition(span.end),
  };
}

/** A statement's span including the newline that ends its line. */
export function wholeLineSpanOf(statement: ts.Node, sourceFile: ts.SourceFile): Span {
  const text = sourceFile.getFullText();
  let end = statement.getEnd();
  while (end < text.length && text[end] !== '\n') end++;
  if (end < text.length) end++;
  return { start: statement.getStart(sourceFile), end };
}

export function wholeLineOf(statement: ts.Node, sourceFile: ts.SourceFile): TextEdit {
  const span = wholeLineSpanOf(statement, sourceFile);
  return {
    range: {
      start: sourceFile.getLineAndCharacterOfPosition(span.start),
      end: sourceFile.getLineAndCharacterOfPosition(span.end),
    },
    newText: '',
  };
}

/**
 * The offsets that unbind a symbol from one file — an import specifier
 * or a re-export specifier — or undefined when the reference is not a
 * binding.
 */
export function bindingSpanOf(reference: ts.Node, sourceFile: ts.SourceFile): Span | undefined {
  const specifier = reference.parent;
  if (!specifier) return undefined;

  if (ts.isExportSpecifier(specifier)) {
    const named = specifier.parent;
    if (named.elements.length > 1) return elementSpanOf(specifier, named.elements, sourceFile);
    return wholeLineSpanOf(named.parent, sourceFile);
  }
  if (!ts.isImportSpecifier(specifier)) return undefined;
  const named = specifier.parent;
  const clause = named.parent;
  if (named.elements.length > 1) return elementSpanOf(specifier, named.elements, sourceFile);
  if (clause.name) return { start: clause.name.getEnd(), end: named.getEnd() };
  return wholeLineSpanOf(clause.parent, sourceFile);
}

/**
 * Remove the binding a file used to reach a symbol — an import
 * specifier or a re-export specifier — given a reference to its name.
 *
 * Returns undefined when the reference is not a binding, so callers can
 * pass every classified reference and let this decide.
 */
export function removeBinding(
  reference: ts.Node,
  sourceFile: ts.SourceFile,
): TextEdit | undefined {
  const span = bindingSpanOf(reference, sourceFile);
  if (!span) return undefined;
  return {
    range: {
      start: sourceFile.getLineAndCharacterOfPosition(span.start),
      end: sourceFile.getLineAndCharacterOfPosition(span.end),
    },
    newText: '',
  };
}

/** `.mts` and `.cts` import as `.mjs`/`.cjs`, not as `.js`. */
const SOURCE_TO_IMPORT_EXTENSION: Record<string, string> = { '.mts': '.mjs', '.cts': '.cjs' };

/** A relative module specifier for `toFile`, as written from `fromFile`. */
export function relativeSpecifier(
  fromFile: string,
  toFile: string,
  withExtension: boolean,
): string {
  const relative = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  const dotted = relative.startsWith('.') ? relative : `./${relative}`;
  const extension = path.extname(dotted);
  const stem = dotted.slice(0, dotted.length - extension.length);
  return withExtension ? stem + (SOURCE_TO_IMPORT_EXTENSION[extension] ?? '.js') : stem;
}

/** The file an import declaration resolves to, if any. */
export function resolvedModuleOf(
  declaration: ts.ImportDeclaration,
  options: ts.CompilerOptions,
): string | undefined {
  if (!ts.isStringLiteral(declaration.moduleSpecifier)) return undefined;
  const resolved = ts.resolveModuleName(
    declaration.moduleSpecifier.text,
    declaration.getSourceFile().fileName,
    options,
    ts.sys,
  ).resolvedModule;
  return resolved ? path.resolve(resolved.resolvedFileName) : undefined;
}

/**
 * Every name visible at a site, by name.
 *
 * SymbolFlags.All, not Value|Type: an imported binding's own flags are
 * Alias whatever it aliases, so a narrower filter omits every import
 * and reports a fully-populated module scope as empty.
 */
export function scopeAt(checker: ts.TypeChecker, site: ts.Node): Map<string, ts.Symbol> {
  const scope = new Map<string, ts.Symbol>();
  for (const symbol of checker.getSymbolsInScope(site, ts.SymbolFlags.All)) {
    if (!scope.has(symbol.name)) scope.set(symbol.name, symbol);
  }
  return scope;
}

/**
 * Whether the project writes `.js` on its relative specifiers. Under
 * NodeNext a missing extension is a compile error rather than a style
 * difference, so this is read from the code rather than assumed.
 */
export function writesExtensions(sourceFiles: readonly ts.SourceFile[]): boolean {
  let extensioned = 0;
  let bare = 0;
  for (const sourceFile of sourceFiles.slice(0, 40)) {
    for (const statement of sourceFile.statements) {
      const specifier =
        ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
          ? statement.moduleSpecifier
          : undefined;
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
      if (/\.[cm]?js$/.test(specifier.text)) extensioned++;
      else bare++;
    }
  }
  return extensioned >= bare;
}
