import path from 'node:path';
import ts from 'typescript';
import type { Finding, Range, Tool } from '../../../core/tool/index.js';
import type { TsProjectSession } from '../../project/index.js';
import { isTestFile } from '../../project/index.js';
import { buildImportGraph, collectModuleRefs } from '../import-graph.js';

/**
 * Finds exported symbols nothing in the project imports
 * (graph.dead-export) and files nothing imports (graph.dead-file),
 * both from one pass over the resolved import graph.
 */

export interface DeadExportsInput {
  /**
   * Globs (relative to the project root; `*` and `**` supported)
   * naming additional entry-point files whose exports are exempt.
   */
  entryPoints?: string[];
  /**
   * Additional consumer roots (e.g. sibling monorepo packages) whose
   * imports count as consumption. Relative paths resolve against the
   * project root. Parsed syntactically — names match by identity, not
   * resolution, so matching is conservative by design.
   */
  extraRoots?: string[];
}

/** Next.js-style files that frameworks load by path, never by import. */
const FRAMEWORK_STEMS = new Set([
  'page',
  'layout',
  'route',
  'loading',
  'error',
  'not-found',
  'template',
  'default',
  'global-error',
]);

const REGEX_SPECIAL = /[.+?^${}()|[\]\\]/;

/** package.json target extension -> the source extensions it may compile from. */
const JS_TO_TS: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
  '.d.ts': ['.ts', '.tsx'],
  '.d.mts': ['.mts'],
  '.d.cts': ['.cts'],
};
const DECLARATION_TARGET = /\.d\.[cm]?ts$/;
const SRC_EXTENSIONS = ['.ts', '.tsx', '.mts'] as const;

/**
 * Translate a minimal glob to an anchored RegExp: `*` matches within
 * one path segment, `**` spans directories (`**` followed by `/`
 * matches zero or more whole directories).
 */
export function translateGlob(glob: string): RegExp {
  const posix = glob.split(path.sep).join('/');
  let pattern = '';
  let i = 0;
  while (i < posix.length) {
    const char = posix.charAt(i);
    if (char === '*') {
      if (posix.charAt(i + 1) === '*') {
        if (posix.charAt(i + 2) === '/') {
          pattern += '(?:.*/)?';
          i += 3;
        } else {
          pattern += '.*';
          i += 2;
        }
      } else {
        pattern += '[^/]*';
        i += 1;
      }
    } else {
      pattern += REGEX_SPECIAL.test(char) ? `\\${char}` : char;
      i += 1;
    }
  }
  return new RegExp(`^${pattern}$`);
}

/** Framework-convention entry files, matched on the root-relative path. */
export function isFrameworkEntry(relativePath: string): boolean {
  const posix = relativePath.split(path.sep).join('/');
  // Generated framework output (Next.js includes .next/types in tsconfig).
  if (/(?:^|\/)\.next\//.test(posix)) return true;
  const base = posix.split('/').pop() ?? posix;
  if (base === 'middleware.ts' || base === 'instrumentation.ts') return true;
  if (/\.config\.m?ts$/.test(base)) return true;
  const stem = /^(.*)\.tsx?$/.exec(base)?.[1];
  return (
    stem !== undefined && FRAMEWORK_STEMS.has(stem) && /(?:^|\/)(?:app|pages)\//.test(posix)
  );
}

/** Every string reachable in a package.json "exports" value (conditions, subpaths, arrays). */
function collectExportTargets(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const item of node) collectExportTargets(item, out);
  else if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) collectExportTargets(value, out);
  }
}

/**
 * Source files a package.json target may correspond to. Built targets
 * ("dist/index.js") usually have no on-disk source at that path, so as
 * a documented heuristic the same basename under the package's src/
 * also counts as the entry.
 */
export function sourceCandidates(packageDir: string, target: string): string[] {
  const resolved = path.resolve(packageDir, target);
  // path.extname sees only the '.ts' of a declaration target, so the
  // compound '.d.ts'/'.d.mts'/'.d.cts' extensions are matched first.
  const extension = DECLARATION_TARGET.exec(resolved)?.[0] ?? path.extname(resolved);
  const candidates = [resolved];
  const substitutes = JS_TO_TS[extension];
  if (substitutes) {
    for (const sub of substitutes) candidates.push(resolved.slice(0, -extension.length) + sub);
  } else if (extension === '') {
    for (const sub of SRC_EXTENSIONS) candidates.push(resolved + sub);
  }
  const stem = path.basename(resolved, extension);
  for (const sub of SRC_EXTENSIONS) candidates.push(path.join(packageDir, 'src', stem + sub));
  return candidates;
}

/**
 * A package.json target that exists on disk but is not program source
 * — a .mjs bin shim that registers a loader and imports the real
 * entry, say — still names entry points: whatever it references.
 * Returns the project files its relative imports (static, dynamic,
 * or `require('./x')` calls) resolve to. One level deep, by design.
 */
function scanShimImports(shimPath: string, projectFiles: ReadonlySet<string>): string[] {
  const text = ts.sys.readFile(shimPath);
  if (text === undefined) return [];
  const sourceFile = ts.createSourceFile(shimPath, text, ts.ScriptTarget.Latest, true);
  const specifiers = collectModuleRefs(sourceFile).map((ref) => ref.specifier);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        specifiers.push(argument.text);
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);

  const shimDir = path.dirname(shimPath);
  const entries: string[] = [];
  for (const specifier of specifiers) {
    if (!specifier.startsWith('.')) continue;
    for (const candidate of sourceCandidates(shimDir, specifier)) {
      if (projectFiles.has(candidate)) entries.push(candidate);
    }
  }
  return entries;
}

interface PackageEntryPoints {
  /** Project source files referenced by any package.json entry field. */
  entryFiles: Set<string>;
  /** Names of every package.json under the root (monorepo workspaces). */
  packageNames: Set<string>;
}

function collectPackageEntryPoints(
  rootPath: string,
  projectFiles: ReadonlySet<string>,
): PackageEntryPoints {
  const entryFiles = new Set<string>();
  const packageNames = new Set<string>();
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
    const pkg = parsed as Record<string, unknown>;
    if (typeof pkg.name === 'string') packageNames.add(pkg.name);

    const targets: string[] = [];
    for (const field of ['main', 'module', 'types']) {
      const value = pkg[field];
      if (typeof value === 'string') targets.push(value);
    }
    if (typeof pkg.bin === 'string') targets.push(pkg.bin);
    else if (pkg.bin !== null && typeof pkg.bin === 'object') {
      for (const value of Object.values(pkg.bin)) {
        if (typeof value === 'string') targets.push(value);
      }
    }
    collectExportTargets(pkg.exports, targets);

    const packageDir = path.dirname(manifest);
    for (const target of targets) {
      for (const candidate of sourceCandidates(packageDir, target)) {
        if (projectFiles.has(candidate)) entryFiles.add(candidate);
      }
      const resolved = path.resolve(packageDir, target);
      if (!projectFiles.has(resolved) && ts.sys.fileExists(resolved)) {
        for (const entry of scanShimImports(resolved, projectFiles)) entryFiles.add(entry);
      }
    }
  }
  return { entryFiles, packageNames };
}

interface ExtraRootConsumption {
  /** Export names imported anywhere in the extra roots. */
  names: Set<string>;
  /** A namespace/star import of the whole project was seen. */
  consumesEverything: boolean;
}

/**
 * Syntactic scan of extra consumer roots: any name imported there
 * counts as consumed project-wide (no resolution — conservative). A
 * namespace import whose specifier's last segment names the analyzed
 * project (its directory or any workspace package name) consumes
 * every file.
 */
function scanExtraRoots(
  roots: readonly string[],
  rootPath: string,
  packageNames: ReadonlySet<string>,
): ExtraRootConsumption {
  const names = new Set<string>();
  let consumesEverything = false;
  const wholeProjectKeys = new Set([path.basename(rootPath), ...packageNames]);
  for (const root of roots) {
    const files = ts.sys.readDirectory(
      path.resolve(rootPath, root),
      ['.ts', '.tsx'],
      ['**/node_modules'],
      undefined,
    );
    for (const file of files) {
      const text = ts.sys.readFile(file);
      if (text === undefined) continue;
      const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      for (const ref of collectModuleRefs(sourceFile)) {
        for (const name of ref.names) {
          if (name !== '*') {
            names.add(name);
            continue;
          }
          const lastSegment = ref.specifier.split('/').filter((s) => s.length > 0).pop();
          if (
            wholeProjectKeys.has(ref.specifier) ||
            (lastSegment !== undefined && wholeProjectKeys.has(lastSegment))
          ) {
            consumesEverything = true;
          }
        }
      }
    }
  }
  return { names, consumesEverything };
}

function firstLineRange(sourceFile: ts.SourceFile): Range {
  return {
    start: { line: 0, character: 0 },
    end: sourceFile.getLineAndCharacterOfPosition(sourceFile.getLineEndOfPosition(0)),
  };
}

export interface FileAuditOptions {
  /**
   * Consumption included name-matched extraRoots (approximate), so
   * value-export confidence drops to medium.
   */
  approximate?: boolean;
  /** Importer count recorded on each finding. */
  importersOfFile?: number;
}

/**
 * Audits one module's own exports against the names the import graph
 * says are consumed from it ('*' consumes everything). Pure per-file
 * core of the tool, callable on any program's source file without a
 * session.
 */
export function findDeadExportsInFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  consumedNames: ReadonlySet<string>,
  options: FileAuditOptions = {},
): Finding[] {
  if (consumedNames.has('*')) return [];
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return [];
  const approximate = options.approximate ?? false;
  const importersOfFile = options.importersOfFile ?? 0;
  const file = path.resolve(sourceFile.fileName);

  const findings: Finding[] = [];
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const exportName = symbol.name;
    if (exportName === 'export=') continue;
    if (consumedNames.has(exportName)) continue;
    // A symbol with no declaration in this file arrived through a star
    // re-export; the '*' recorded against its declaring file already
    // keeps it alive there, so auditing it here would misreport
    // directly-imported names as dead.
    const decl = symbol.declarations?.find((d) => d.getSourceFile() === sourceFile);
    if (!decl) continue;

    const target =
      symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const isValue = (target.flags & ts.SymbolFlags.Value) !== 0;
    const nameNode: ts.Node = ts.getNameOfDeclaration(decl) ?? decl;
    const isDefault = exportName === 'default';
    const name = isDefault && ts.isIdentifier(nameNode) ? nameNode.text : exportName;
    const subject = isDefault
      ? name === 'default'
        ? 'The default export'
        : `The default export ("${name}")`
      : isValue
        ? `Export "${exportName}"`
        : `Type export "${exportName}"`;
    const message = isValue
      ? `${subject} is imported nowhere in the project. Unused exports widen the apparent API surface; delete it or drop the export keyword.`
      : `${subject} is imported nowhere in the project. Types are often exported only for downstream annotation, so confirm nothing external relies on it before deleting.`;

    findings.push({
      file,
      range: {
        start: sourceFile.getLineAndCharacterOfPosition(nameNode.getStart(sourceFile)),
        end: sourceFile.getLineAndCharacterOfPosition(nameNode.getEnd()),
      },
      code: 'graph.dead-export',
      message,
      severity: isValue ? 'warning' : 'info',
      data: {
        name,
        kind: isValue ? 'value' : 'type',
        confidence: isValue ? (approximate ? 'medium' : 'high') : 'medium',
        importersOfFile,
      },
    });
  }
  return findings;
}

export const deadExports: Tool<DeadExportsInput, Finding[], TsProjectSession> = {
  name: 'ts/graph/dead-exports',
  description:
    'Finds exported symbols nothing in the project imports (graph.dead-export) and files ' +
    'nothing imports (graph.dead-file), by resolving every import, re-export, dynamic ' +
    'import, and require through the compiler module resolution, tsconfig paths aliases ' +
    'included. Package entry points (package.json main/module/types/bin/exports, plus ' +
    'the files a non-source bin shim imports), ' +
    'framework-convention files, and test files are exempt; a namespace, star, or dynamic ' +
    'import keeps every export of its target alive. Findings are deletion candidates; ' +
    'verify type exports meant for downstream consumers before removing them.',
  inputSchema: {
    type: 'object',
    properties: {
      entryPoints: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Globs relative to the project root (* and ** supported) naming additional entry-point files whose exports are exempt',
      },
      extraRoots: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Additional consumer roots (sibling monorepo packages) scanned syntactically; names imported there count as consumed',
      },
    },
    additionalProperties: false,
  },
  outputSchema: { type: 'array', items: { $ref: '#/definitions/finding' } },
  run(session, input) {
    const graph = buildImportGraph(session);
    const checker = session.checker();
    const rootPath = session.rootPath;
    const files = session.sourceFiles();
    const projectFiles = new Set(files.map((sf) => path.resolve(sf.fileName)));
    const { entryFiles, packageNames } = collectPackageEntryPoints(rootPath, projectFiles);
    const entryGlobs = (input.entryPoints ?? []).map(translateGlob);
    const extra =
      input.extraRoots !== undefined && input.extraRoots.length > 0
        ? scanExtraRoots(input.extraRoots, rootPath, packageNames)
        : undefined;

    const findings: Finding[] = [];
    for (const sourceFile of files) {
      const file = path.resolve(sourceFile.fileName);
      const relative = path.relative(rootPath, file).split(path.sep).join('/');
      const isEntry =
        entryFiles.has(file) ||
        isFrameworkEntry(relative) ||
        entryGlobs.some((glob) => glob.test(relative));
      if (isEntry || isTestFile(file)) continue;

      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      const exportSymbols = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
      const importersOfFile = graph.importers.get(file)?.size ?? 0;
      const aliveViaExtra =
        extra !== undefined &&
        (extra.consumesEverything || exportSymbols.some((s) => extra.names.has(s.name)));

      if (importersOfFile === 0 && !aliveViaExtra) {
        // One finding for the whole file; its exports are not also
        // flagged. A script file (no module symbol) contributes ambient
        // globals the import graph cannot see, so certainty drops.
        const isScript = moduleSymbol === undefined;
        findings.push({
          file,
          range: firstLineRange(sourceFile),
          code: 'graph.dead-file',
          message: isScript
            ? 'Nothing in the project imports this file, but it has no imports or exports ' +
              'either — a script, not a module — so its declarations are ambient globals; ' +
              'confirm nothing references them before deleting it.'
            : 'Nothing in the project imports this file, and it is not a recognized entry ' +
              'point, framework file, or test; the whole file is a deletion candidate.',
          severity: isScript ? 'info' : 'warning',
          data: {
            name: relative,
            kind: 'file',
            confidence: isScript ? 'low' : 'high',
            importersOfFile: 0,
          },
        });
        continue;
      }

      if (extra?.consumesEverything) continue;
      const consumed = new Set(graph.consumedNames.get(file));
      if (extra !== undefined) for (const name of extra.names) consumed.add(name);
      findings.push(
        ...findDeadExportsInFile(sourceFile, checker, consumed, {
          approximate: extra !== undefined,
          importersOfFile,
        }),
      );
    }
    return Promise.resolve(findings);
  },
};
