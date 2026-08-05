import path from 'node:path';
import ts from 'typescript';
import type { Range } from '../../core/tool/index.js';
import type { TsProjectSession } from '../project/index.js';

/**
 * Shared module-graph infrastructure (not a registered tool). Walks
 * every project source file for static imports, re-exports, dynamic
 * `import('...')` with a literal specifier, and `import x = require`,
 * then resolves each specifier through the compiler's own module
 * resolution — the program's options carry the real tsconfig
 * paths/baseUrl, so aliases behave exactly as tsc sees them.
 */

export interface ImportEdge {
  /** Absolute path of the importing file. */
  from: string;
  /** Absolute path of the resolved target file. */
  to: string;
  /** `import type` / `export type ... from` / every specifier type-only. */
  typeOnly: boolean;
  /** The import statement's range within `from`. */
  range: Range;
}

export interface ImportGraph {
  edges: ImportEdge[];
  /** Target file -> export names consumed from it; '*' = namespace/star/dynamic (everything). */
  consumedNames: Map<string, Set<string>>;
  /** Target file -> importing files (deduped). */
  importers: Map<string, Set<string>>;
}

/** One module reference as written in a file, before resolution. */
export interface ModuleRef {
  specifier: string;
  /** Names consumed from the target; '*' = everything; empty = side-effect only. */
  names: string[];
  typeOnly: boolean;
  range: Range;
}

const DECLARATION_FILE = /\.d\.[cm]?ts$/;

function isImportMetaUrl(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'url' &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === 'meta'
  );
}

/**
 * The module a dynamic import names: a string literal, or the literal
 * inside `new URL('./x', import.meta.url)` with or without `.href` —
 * the standard shape of bin shims that load sources through a
 * registered loader. Both resolve relative to the importing file.
 */
function dynamicImportSpecifier(argument: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(argument)) return argument.text;
  const url =
    ts.isPropertyAccessExpression(argument) && argument.name.text === 'href'
      ? argument.expression
      : argument;
  if (!ts.isNewExpression(url) || !ts.isIdentifier(url.expression)) return undefined;
  if (url.expression.text !== 'URL' || url.arguments?.length !== 2) return undefined;
  const specifier = url.arguments[0];
  const base = url.arguments[1];
  if (specifier === undefined || base === undefined) return undefined;
  return ts.isStringLiteralLike(specifier) && isImportMetaUrl(base) ? specifier.text : undefined;
}

function rangeOf(sourceFile: ts.SourceFile, node: ts.Node): Range {
  return {
    start: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)),
    end: sourceFile.getLineAndCharacterOfPosition(node.getEnd()),
  };
}

function importClauseNames(clause: ts.ImportClause | undefined): string[] {
  if (!clause) return [];
  const names: string[] = [];
  if (clause.name) names.push('default');
  const bindings = clause.namedBindings;
  if (bindings) {
    if (ts.isNamespaceImport(bindings)) names.push('*');
    else for (const element of bindings.elements) names.push((element.propertyName ?? element.name).text);
  }
  return names;
}

function importClauseTypeOnly(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  return (
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

/**
 * Every module reference in one file, syntactically. Re-export names
 * are recorded against the source module (`export { X } from './y'`
 * consumes X from y), so re-export chains keep public API alive
 * through entry points. Dynamic imports count only with a literal
 * specifier (directly or via `new URL(literal, import.meta.url)`) —
 * a computed one names no file to resolve.
 */
export function collectModuleRefs(sourceFile: ts.SourceFile): ModuleRef[] {
  const refs: ModuleRef[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      refs.push({
        specifier: node.moduleSpecifier.text,
        names: importClauseNames(node.importClause),
        typeOnly: importClauseTypeOnly(node.importClause),
        range: rangeOf(sourceFile, node),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      const named = clause !== undefined && ts.isNamedExports(clause) ? clause : undefined;
      refs.push({
        specifier: node.moduleSpecifier.text,
        names: named ? named.elements.map((e) => (e.propertyName ?? e.name).text) : ['*'],
        typeOnly:
          node.isTypeOnly ||
          (named !== undefined &&
            named.elements.length > 0 &&
            named.elements.every((element) => element.isTypeOnly)),
        range: rangeOf(sourceFile, node),
      });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      const specifier = argument === undefined ? undefined : dynamicImportSpecifier(argument);
      if (specifier !== undefined) {
        refs.push({
          specifier,
          names: ['*'],
          typeOnly: false,
          range: rangeOf(sourceFile, node),
        });
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      refs.push({
        specifier: node.moduleReference.expression.text,
        names: ['*'],
        typeOnly: node.isTypeOnly,
        range: rangeOf(sourceFile, node),
      });
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return refs;
}

/**
 * The project's resolved module graph. Only edges landing inside the
 * project survive (same membership rules as session.sourceFiles(): not
 * a declaration file, not node_modules, under the project root). A
 * type-only edge still consumes names — types are real symbols —
 * typeOnly matters only to cycle analysis.
 */
export function buildImportGraph(session: TsProjectSession): ImportGraph {
  const options = session.program().getCompilerOptions();
  const edges: ImportEdge[] = [];
  const consumedNames = new Map<string, Set<string>>();
  const importers = new Map<string, Set<string>>();

  for (const sourceFile of session.sourceFiles()) {
    const from = path.resolve(sourceFile.fileName);
    for (const ref of collectModuleRefs(sourceFile)) {
      const resolved = ts.resolveModuleName(
        ref.specifier,
        sourceFile.fileName,
        options,
        ts.sys,
      ).resolvedModule;
      if (!resolved) continue;
      const to = path.resolve(resolved.resolvedFileName);
      if (DECLARATION_FILE.test(to)) continue;
      if (to.includes(`${path.sep}node_modules${path.sep}`)) continue;
      if (!to.startsWith(session.rootPath + path.sep)) continue;

      edges.push({ from, to, typeOnly: ref.typeOnly, range: ref.range });
      let importerSet = importers.get(to);
      if (!importerSet) {
        importerSet = new Set();
        importers.set(to, importerSet);
      }
      importerSet.add(from);
      if (ref.names.length > 0) {
        let nameSet = consumedNames.get(to);
        if (!nameSet) {
          nameSet = new Set();
          consumedNames.set(to, nameSet);
        }
        for (const name of ref.names) nameSet.add(name);
      }
    }
  }
  return { edges, consumedNames, importers };
}
