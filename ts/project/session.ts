import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { FileScope } from '../../core/files/index.js';
import type { ProjectSession } from '../../core/tool/index.js';
import type { LspClient } from '../../core/lsp/index.js';
import { startTsServer } from '../server/spawn.js';
import { hasHiddenDirSegment } from './paths.js';
import { TsLanguageService } from './service.js';

/**
 * A bound connection to one TypeScript project on disk, owning two
 * lazily-created views of it:
 *
 * - the LSP view (typescript-language-server) for rename, references,
 *   definitions — anything the protocol already does well;
 * - the compiler view (ts.Program + TypeChecker) for ASTs, comments,
 *   and symbol-table work the protocol has no vocabulary for.
 *
 * The compiler view is served by a ts.LanguageService rather than a
 * bare ts.Program, because refactorings need what only the service
 * indexes — references, applicable refactors, edits for a refactor or
 * a file rename, code fixes. Both come from the same service, so a
 * symbol resolved through the checker and a reference found through
 * the service belong to one graph rather than two.
 *
 * Tools mutate through WorkspaceEdits; after an apply, invalidate()
 * re-reads the changed files from disk.
 */
/** Extensions a ts.Program can hold source files for. */
export const TS_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/**
 * The tsconfig.json a project at `absRoot` binds to, if any. Shared by
 * open() and by the pack's binds() so the two cannot drift and offer a
 * tool that then fails to open a session.
 */
function findTsConfig(absRoot: string): string | undefined {
  const configPath = ts.findConfigFile(absRoot, ts.sys.fileExists.bind(ts.sys));
  if (!configPath) return undefined;
  const resolved = path.resolve(configPath);
  return resolved.startsWith(absRoot + path.sep) ? resolved : undefined;
}

/** Would open() succeed here? Filesystem only — no session, no server. */
export function bindsTypeScript(rootPath: string): boolean {
  return findTsConfig(path.resolve(rootPath)) !== undefined;
}

export class TsProjectSession implements ProjectSession {
  readonly language = 'ts';
  readonly rootPath: string;
  readonly configPath: string;

  #lsp: Promise<LspClient> | undefined;
  #parsed: ts.ParsedCommandLine | undefined;
  #service: TsLanguageService | undefined;
  #scope: FileScope | undefined;

  private constructor(rootPath: string, configPath: string) {
    this.rootPath = rootPath;
    this.configPath = configPath;
  }

  static open(rootPath: string): TsProjectSession {
    const absRoot = path.resolve(rootPath);
    const configPath = findTsConfig(absRoot);
    if (!configPath) {
      throw new Error(`No tsconfig.json found under ${absRoot}`);
    }
    return new TsProjectSession(absRoot, configPath);
  }

  /** The LSP view. First call spawns and initializes the server. */
  lsp(): Promise<LspClient> {
    this.#lsp ??= startTsServer(this.rootPath);
    return this.#lsp;
  }

  /**
   * Opens a document with the LSP view and waits until the server has
   * published diagnostics for it — tsserver answers requests before
   * its project finishes loading, and pre-load answers are wrong
   * (imports still look like unresolved aliases). Diagnostics arriving
   * is the earliest reliable signal that the project is ready.
   */
  async openDocument(filePath: string): Promise<string> {
    const lsp = await this.lsp();
    const uri = pathToFileURL(path.resolve(filePath)).href;
    if (lsp.isDocumentOpen(uri)) return uri;
    const ready = lsp.waitForNotification<{ uri: string }>(
      'textDocument/publishDiagnostics',
      (params) => params.uri === uri,
      10_000,
    );
    await lsp.openDocument(path.resolve(filePath), 'typescript');
    await ready;
    return uri;
  }

  /** The parsed tsconfig, shared by both compiler-side views. */
  parsedConfig(): ts.ParsedCommandLine {
    if (!this.#parsed) {
      const parsed = ts.getParsedCommandLineOfConfigFile(this.configPath, undefined, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(
            `Failed to parse ${this.configPath}: ` +
              ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
          );
        },
      });
      if (!parsed) throw new Error(`Failed to parse ${this.configPath}`);
      this.#parsed = parsed;
    }
    return this.#parsed;
  }

  /**
   * The language-service view: references, refactorings, code fixes.
   * First call parses tsconfig and builds the service.
   */
  languageService(): TsLanguageService {
    if (!this.#service) {
      const parsed = this.parsedConfig();
      this.#service = new TsLanguageService(parsed.fileNames, parsed.options);
    }
    return this.#service;
  }

  /** The compiler view. First call parses tsconfig and typechecks. */
  program(): ts.Program {
    return this.languageService().program();
  }

  checker(): ts.TypeChecker {
    return this.program().getTypeChecker();
  }

  /**
   * Program files that live under the project root (not lib/.d.ts
   * files, not node_modules) — the raw membership test, hidden
   * directories included. The import graph walks this set so that
   * imports written in generated files still contribute edges; tools
   * report findings only on sourceFiles() members.
   */
  projectFiles(): ts.SourceFile[] {
    return this.program()
      .getSourceFiles()
      .filter(
        (sf) =>
          !sf.isDeclarationFile &&
          !sf.fileName.includes('/node_modules/') &&
          path.resolve(sf.fileName).startsWith(this.rootPath + path.sep),
      );
  }

  /**
   * Every file in the compilation a tool may rewrite: not a declaration
   * file, not a dependency.
   *
   * Unlike projectFiles()/sourceFiles() this is not narrowed to the
   * root, because an edit's blast radius is the program rather than the
   * directory — a barrel pulled in by `include: ["../lib"]` breaks the
   * build exactly as one under `src` does, and the guard typechecks
   * both. Analysis reports findings in sourceFiles(); a pass that
   * repairs what an edit broke iterates this.
   */
  compilationFiles(): ts.SourceFile[] {
    return this.program()
      .getSourceFiles()
      .filter(
        (sf) => !sf.isDeclarationFile && !sf.fileName.includes('/node_modules/'),
      );
  }

  /**
   * Source files that analysis tools may report findings in. Files
   * under hidden directories are generated framework output — Next.js
   * includes .next/types in tsconfig, for example — and are excluded:
   * analysis findings there would audit code the project doesn't own.
   * Only segments below the root count as hidden, so a project living
   * under a dot-directory is unaffected.
   */
  sourceFiles(): ts.SourceFile[] {
    return this.projectFiles().filter(
      (sf) =>
        !hasHiddenDirSegment(path.resolve(sf.fileName).slice(this.rootPath.length + 1)),
    );
  }

  /**
   * The source files a tool should report findings in: sourceFiles(),
   * narrowed to the caller's file scope when one is set (a hook's
   * changed-files list). Tools iterate this to produce findings but
   * keep building project-wide context — symbol indexes, import graphs,
   * duplicate groups — from sourceFiles()/projectFiles(), which the
   * scope never touches.
   */
  targetFiles(): ts.SourceFile[] {
    const scope = this.#scope;
    if (!scope) return this.sourceFiles();
    return this.sourceFiles().filter((sf) => scope.has(sf.fileName));
  }

  /**
   * Set (or clear, with undefined) the reporting scope. The dispatch
   * layer owns this: it sets a scope for the duration of one tool call
   * and clears it after, serializing calls against the same session so
   * one call's scope can never leak into another's.
   */
  setScope(scope: FileScope | undefined): void {
    this.#scope = scope;
  }

  /**
   * Re-read from disk after applying edits. `changed` names the files
   * an edit touched; without it every file is treated as changed.
   * Files created or deleted by the edit enter and leave the
   * compilation here, so the next call sees the project as it now is.
   */
  invalidate(changed?: {
    written?: readonly string[];
    created?: readonly string[];
    deleted?: readonly string[];
  }): void {
    if (!this.#service) return;
    if (!changed) {
      this.#service.invalidate();
      return;
    }
    this.#service.addRootNames(changed.created ?? []);
    this.#service.removeRootNames(changed.deleted ?? []);
    this.#service.invalidate([
      ...(changed.written ?? []),
      ...(changed.created ?? []),
      ...(changed.deleted ?? []),
    ]);
  }

  async dispose(): Promise<void> {
    if (this.#lsp) {
      const lsp = this.#lsp;
      this.#lsp = undefined;
      await (await lsp).shutdown();
    }
    this.#service?.dispose();
    this.#service = undefined;
    this.#parsed = undefined;
  }
}
