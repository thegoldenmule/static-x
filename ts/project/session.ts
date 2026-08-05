import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { ProjectSession } from '../../core/tool/index.js';
import type { LspClient } from '../../core/lsp/index.js';
import { startTsServer } from '../server/spawn.js';

/**
 * A bound connection to one TypeScript project on disk, owning two
 * lazily-created views of it:
 *
 * - the LSP view (typescript-language-server) for rename, references,
 *   definitions — anything the protocol already does well;
 * - the compiler view (ts.Program + TypeChecker) for ASTs, comments,
 *   and symbol-table work the protocol has no vocabulary for.
 *
 * Tools mutate through WorkspaceEdits; after an apply, invalidate()
 * drops the compiler view so the next call re-reads from disk.
 */
export class TsProjectSession implements ProjectSession {
  readonly language = 'ts';
  readonly rootPath: string;
  readonly configPath: string;

  #lsp: Promise<LspClient> | undefined;
  #program: ts.Program | undefined;

  private constructor(rootPath: string, configPath: string) {
    this.rootPath = rootPath;
    this.configPath = configPath;
  }

  static open(rootPath: string): TsProjectSession {
    const absRoot = path.resolve(rootPath);
    const configPath = ts.findConfigFile(absRoot, ts.sys.fileExists.bind(ts.sys));
    if (!configPath || !path.resolve(configPath).startsWith(absRoot + path.sep)) {
      throw new Error(`No tsconfig.json found under ${absRoot}`);
    }
    return new TsProjectSession(absRoot, path.resolve(configPath));
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

  /** The compiler view. First call parses tsconfig and typechecks. */
  program(): ts.Program {
    if (!this.#program) {
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
      this.#program = ts.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
      });
    }
    return this.#program;
  }

  checker(): ts.TypeChecker {
    return this.program().getTypeChecker();
  }

  /** Source files that belong to the project (not lib/.d.ts files). */
  sourceFiles(): ts.SourceFile[] {
    return this.program()
      .getSourceFiles()
      .filter(
        (sf) =>
          !sf.isDeclarationFile &&
          !sf.fileName.includes('/node_modules/') &&
          path.resolve(sf.fileName).startsWith(this.rootPath + path.sep),
      );
  }

  /** Drop cached views that read from disk; used after applying edits. */
  invalidate(): void {
    this.#program = undefined;
  }

  async dispose(): Promise<void> {
    if (this.#lsp) {
      const lsp = this.#lsp;
      this.#lsp = undefined;
      await (await lsp).shutdown();
    }
    this.#program = undefined;
  }
}
