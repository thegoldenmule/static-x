import path from 'node:path';
import ts from 'typescript';

/**
 * The third view of a project, alongside the LSP client and the raw
 * ts.Program: a ts.LanguageService.
 *
 * ts.Program answers questions about types and ASTs but indexes no
 * references and offers no transformations, so findReferences,
 * getApplicableRefactors, getEditsForRefactor, getEditsForFileRename,
 * organizeImports, and the code fixes are only reachable here. It is
 * the same engine tsserver runs, minus the process boundary and minus
 * having to smuggle edits back through workspace/applyEdit.
 *
 * The host reads through an overlay so a proposed edit can be
 * typechecked before it touches disk, and versions every script it
 * serves so an applied edit invalidates exactly the files it changed.
 */
export class TsLanguageService {
  readonly #options: ts.CompilerOptions;
  readonly #rootNames: string[];
  readonly #versions = new Map<string, number>();
  readonly #overlay = new Map<string, string>();
  /** Paths an edit removes, which must look absent, not empty. */
  readonly #hidden = new Set<string>();
  readonly #service: ts.LanguageService;

  constructor(rootNames: readonly string[], options: ts.CompilerOptions) {
    this.#options = options;
    this.#rootNames = rootNames.map((name) => ts.sys.resolvePath(name));

    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () =>
        [...new Set([...this.#rootNames, ...this.#overlay.keys()])].filter(
          (file) => !this.#hidden.has(file),
        ),
      getScriptVersion: (fileName) => String(this.#versions.get(ts.sys.resolvePath(fileName)) ?? 0),
      getScriptSnapshot: (fileName) => {
        const resolved = ts.sys.resolvePath(fileName);
        if (this.#hidden.has(resolved)) return undefined;
        const overlaid = this.#overlay.get(resolved);
        if (overlaid !== undefined) return ts.ScriptSnapshot.fromString(overlaid);
        const text = ts.sys.readFile(resolved);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
      getCompilationSettings: () => this.#options,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (fileName) => {
        const resolved = ts.sys.resolvePath(fileName);
        if (this.#hidden.has(resolved)) return false;
        return this.#overlay.has(resolved) || ts.sys.fileExists(fileName);
      },
      readFile: (fileName) => {
        const resolved = ts.sys.resolvePath(fileName);
        if (this.#hidden.has(resolved)) return undefined;
        return this.#overlay.get(resolved) ?? ts.sys.readFile(fileName);
      },
      readDirectory: ts.sys.readDirectory.bind(ts.sys),
      // Module resolution probes for the containing directory before it
      // looks for a file, so a file the overlay places in a directory
      // that does not exist yet would not resolve — every importer of a
      // symbol moved into a new folder would report TS2307 against an
      // edit that is in fact correct.
      directoryExists: (directory) =>
        this.#overlayDirectories().has(ts.sys.resolvePath(directory)) ||
        ts.sys.directoryExists(directory),
      getDirectories: (directory) => {
        const resolved = ts.sys.resolvePath(directory);
        const onDisk = ts.sys.directoryExists(directory) ? ts.sys.getDirectories(directory) : [];
        const implied: string[] = [];
        for (const candidate of this.#overlayDirectories()) {
          if (path.dirname(candidate) === resolved) implied.push(path.basename(candidate));
        }
        return [...new Set([...onDisk, ...implied])];
      },
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      ...(ts.sys.realpath ? { realpath: ts.sys.realpath.bind(ts.sys) } : {}),
    };
    this.#service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  get service(): ts.LanguageService {
    return this.#service;
  }

  program(): ts.Program {
    const program = this.#service.getProgram();
    if (!program) throw new Error('Language service produced no program');
    return program;
  }

  /**
   * Serve `text` for `file` instead of what is on disk, adding the file
   * to the compilation if it is new. Returns a function that puts the
   * overlay back the way it was — the guard typechecks a proposed edit
   * this way without writing anything.
   */
  overlay(files: Map<string, string>, removed: readonly string[] = []): () => void {
    const previousOverlay = new Map<string, string | undefined>();
    const previousRoots = [...this.#rootNames];
    const previousHidden = new Set(this.#hidden);

    for (const [file, text] of files) {
      const resolved = ts.sys.resolvePath(file);
      previousOverlay.set(resolved, this.#overlay.get(resolved));
      this.#overlay.set(resolved, text);
      this.#hidden.delete(resolved);
      this.#bump(resolved);
      if (!this.#rootNames.includes(resolved)) this.#rootNames.push(resolved);
    }
    // A file the edit deletes must go absent rather than empty. An
    // empty file still resolves, so `import './x.js'` and
    // `export * from './x.js'` keep typechecking and the guard reports
    // clean on exactly the references the deletion broke.
    for (const file of removed) {
      const resolved = ts.sys.resolvePath(file);
      if (files.has(resolved)) continue;
      this.#hidden.add(resolved);
      this.#bump(resolved);
      const index = this.#rootNames.indexOf(resolved);
      if (index !== -1) this.#rootNames.splice(index, 1);
    }
    this.#directories = undefined;

    return () => {
      for (const [file, text] of previousOverlay) {
        if (text === undefined) this.#overlay.delete(file);
        else this.#overlay.set(file, text);
        this.#bump(file);
      }
      for (const file of this.#hidden) this.#bump(file);
      this.#hidden.clear();
      for (const file of previousHidden) this.#hidden.add(file);
      this.#rootNames.length = 0;
      this.#rootNames.push(...previousRoots);
      this.#directories = undefined;
    };
  }

  #directories: Set<string> | undefined;

  /** Every directory an overlaid path implies, up to the filesystem root. */
  #overlayDirectories(): Set<string> {
    if (!this.#directories) {
      this.#directories = new Set<string>();
      for (const file of this.#overlay.keys()) {
        let directory = path.dirname(file);
        while (directory !== path.dirname(directory)) {
          if (this.#directories.has(directory)) break;
          this.#directories.add(directory);
          directory = path.dirname(directory);
        }
      }
    }
    return this.#directories;
  }

  #bump(file: string): void {
    this.#versions.set(file, (this.#versions.get(file) ?? 0) + 1);
  }

  /**
   * Mark files as changed on disk. Without this the service keeps
   * serving the snapshot it cached before an apply wrote over it.
   */
  invalidate(files?: readonly string[]): void {
    if (!files) {
      for (const file of [...this.#versions.keys()]) this.#bump(file);
      for (const file of this.#rootNames) this.#bump(file);
      return;
    }
    for (const file of files) this.#bump(ts.sys.resolvePath(file));
  }

  /** Add files that appeared on disk after the service was created. */
  addRootNames(files: readonly string[]): void {
    for (const file of files) {
      const resolved = ts.sys.resolvePath(file);
      if (!this.#rootNames.includes(resolved)) this.#rootNames.push(resolved);
      this.#bump(resolved);
    }
  }

  /** Drop files the project no longer contains. */
  removeRootNames(files: readonly string[]): void {
    for (const file of files) {
      const index = this.#rootNames.indexOf(ts.sys.resolvePath(file));
      if (index !== -1) this.#rootNames.splice(index, 1);
    }
  }

  dispose(): void {
    this.#service.dispose();
  }
}
