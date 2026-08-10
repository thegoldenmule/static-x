import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit, previewWorkspaceEdit } from '../../../core/edits/index.js';
import type { TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { sourceCandidates } from '../../graph/dead-exports/dead-exports.js';
import type { TsProjectSession } from '../../project/index.js';
import { toProjectRelative } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { formatSettings, userPreferences } from '../refactor-action.js';
import { toWorkspaceEdit } from '../text-changes.js';

/**
 * Moving a file is not a filesystem operation with a cleanup pass after
 * it: in TypeScript a module specifier *is* a path, so the file's new
 * location is already written into every importer and into every
 * relative import the file itself makes. The compiler computes both
 * halves of that rewrite; this tool packages them with the rename.
 */

export interface MoveFileInput {
  /** The file to move, project-relative or absolute. */
  file: string;
  /** Full destination path... */
  toFile?: string;
  /** ...or a destination directory, keeping the file's name. */
  toDirectory?: string;
  /** Write the edit to disk. Default false: return the edit only. */
  apply?: boolean;
}

export type MoveFileOutput = RefactorOutput;

const CONFIG_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];

function samePath(a: string, b: string): boolean {
  return ts.sys.useCaseSensitiveFileNames ? a === b : a.toLowerCase() === b.toLowerCase();
}

function destinationOf(rootPath: string, input: MoveFileInput, source: string): string {
  const { toFile, toDirectory } = input;
  if (toFile !== undefined && toDirectory !== undefined) {
    throw new Error('Provide toFile or toDirectory, not both');
  }
  if (toFile !== undefined) return path.resolve(rootPath, toFile);
  if (toDirectory !== undefined) {
    return path.resolve(rootPath, toDirectory, path.basename(source));
  }
  throw new Error(
    'Provide either toFile (the destination path) or toDirectory (the destination folder)',
  );
}

/**
 * The engine reports the moved file's own rewritten specifiers under the
 * path the file still has, while a WorkspaceEdit keys changes by the
 * path they will have — so the moved file's entry is re-keyed. Getting
 * this backwards writes the moved file's new contents to its old
 * location and leaves the copy at the destination stale.
 */
function withRename(edit: WorkspaceEdit, oldFile: string, newFile: string): WorkspaceEdit {
  const changes: Record<string, TextEdit[]> = {};
  for (const [file, edits] of Object.entries(edit.changes)) {
    changes[file === oldFile ? newFile : file] = edits;
  }
  return { changes, fileOps: [...(edit.fileOps ?? []), { kind: 'rename', oldFile, newFile }] };
}

/** Every string a package.json entry field points at, with its field path. */
function entryTargets(
  node: unknown,
  field: string,
  into: { field: string; target: string }[],
): void {
  if (typeof node === 'string') into.push({ field, target: node });
  else if (Array.isArray(node)) {
    node.forEach((item, index) => entryTargets(item, `${field}[${index}]`, into));
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) entryTargets(value, `${field}.${key}`, into);
  }
}

/**
 * package.json entry fields naming the moved file. Nothing compiles a
 * manifest, so a stale `bin` or `exports` typechecks perfectly and fails
 * at install or import time. Target-to-source matching is
 * ts/graph/dead-exports' — a built `dist/index.js` counts as naming the
 * same-named file under `src/`.
 */
function packageEntryWarnings(rootPath: string, moved: string): string[] {
  const warnings: string[] = [];
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

    const targets: { field: string; target: string }[] = [];
    for (const field of ['main', 'module', 'types', 'bin', 'exports']) {
      entryTargets(pkg[field], field, targets);
    }

    const dir = path.dirname(manifest);
    for (const { field, target } of targets) {
      if (!sourceCandidates(dir, target).some((candidate) => samePath(candidate, moved))) continue;
      warnings.push(
        `${toProjectRelative(rootPath, manifest)} "${field}": "${target}" points at the moved ` +
          'file; package manifests are not compiled, so update it by hand.',
      );
    }
  }
  return warnings;
}

/** Does a tsconfig `paths` target (at most one `*`) cover this file? */
function matchesPattern(pattern: string, file: string): boolean {
  const star = pattern.indexOf('*');
  if (star === -1) return samePath(pattern, file);
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (file.length < prefix.length + suffix.length) return false;
  return (
    samePath(file.slice(0, prefix.length), prefix) &&
    samePath(file.slice(file.length - suffix.length), suffix)
  );
}

/**
 * `paths` aliases the move leaves behind, read from the tsconfig as the
 * edit will leave it: TypeScript rewrites a mapping that names the file
 * outright, so what survives here is a wildcard whose subtree the file
 * has left. An import through it still typechecks against whatever else
 * the alias resolves to, or fails only where the alias is read at
 * runtime — neither is a diagnostic about this edit.
 */
function pathAliasWarnings(
  session: TsProjectSession,
  configText: string,
  moved: string,
  destination: string,
): string[] {
  const config = ts.parseConfigFileTextToJson(session.configPath, configText).config as
    | { compilerOptions?: { baseUrl?: unknown; paths?: unknown } }
    | undefined;
  const paths = config?.compilerOptions?.paths;
  if (paths === null || typeof paths !== 'object') return [];
  const baseUrl = config?.compilerOptions?.baseUrl;
  const base = path.resolve(
    path.dirname(session.configPath),
    typeof baseUrl === 'string' ? baseUrl : '.',
  );

  const warnings: string[] = [];
  for (const [alias, targets] of Object.entries(paths as Record<string, unknown>)) {
    if (!Array.isArray(targets)) continue;
    for (const target of targets) {
      if (typeof target !== 'string') continue;
      const pattern = path.resolve(base, target);
      if (!matchesPattern(pattern, moved) || matchesPattern(pattern, destination)) continue;
      warnings.push(
        `${toProjectRelative(session.rootPath, session.configPath)} paths alias "${alias}" ` +
          `("${target}") covered the file at its old location and does not cover the new one.`,
      );
    }
  }
  return warnings;
}

/**
 * Root-level `*.config.*` files that name the moved file outright — a
 * test include list, a bundler entry. Only an exact path is reported:
 * a directory glob usually still covers the new location, and guessing
 * which ones do not would trade a missed hazard for a false one.
 */
function configFileWarnings(rootPath: string, moved: string): string[] {
  const relative = toProjectRelative(rootPath, moved);
  const emitted = relative.replace(/\.([cm]?)tsx?$/, '.$1js');
  const warnings: string[] = [];
  for (const file of ts.sys.readDirectory(rootPath, CONFIG_EXTENSIONS, ['**/node_modules'], [
    '*.config.*',
  ])) {
    const text = ts.sys.readFile(file);
    if (text === undefined) continue;
    if (!text.includes(relative) && !text.includes(emitted)) continue;
    warnings.push(
      `${toProjectRelative(rootPath, file)} names "${relative}"; it is configuration, not ` +
        'compiled source, so the move does not update it.',
    );
  }
  return warnings;
}

export const moveFile: Tool<MoveFileInput, MoveFileOutput, TsProjectSession> = {
  name: 'ts/refactors/move-file',
  description:
    'Moves or renames a source file and rewrites every module specifier that resolves to ' +
    'it, plus the relative specifiers the file itself writes, plus the project tsconfig ' +
    'files/include/paths entries that name it. Give the file and exactly one of toFile (a ' +
    'full destination path) or toDirectory (a folder, keeping the name); both may be ' +
    'project-relative or absolute. Refuses when the destination exists, when it is outside ' +
    'the project, when source and destination are the same, or when the file is not part of ' +
    'the project. Dry-run by default; apply: true writes to disk unless the in-memory ' +
    'typecheck reports newDiagnostics. warnings name references no compiler reads — ' +
    'package.json entry fields, wildcard paths aliases, config files — which keep ' +
    'typechecking and break at run time.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'The file to move, project-relative or absolute' },
      toFile: {
        type: 'string',
        description: 'Destination path, project-relative or absolute (exclusive with toDirectory)',
      },
      toDirectory: {
        type: 'string',
        description: 'Destination folder; the file keeps its name (exclusive with toFile)',
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    required: ['file'],
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(),
  async run(session, input) {
    const rootPath = session.rootPath;
    const oldFile = path.resolve(rootPath, input.file);
    const newFile = destinationOf(rootPath, input, oldFile);

    if (oldFile === newFile) {
      throw new Error(`${toProjectRelative(rootPath, oldFile)} is already where it would move to`);
    }
    if (!newFile.startsWith(rootPath + path.sep)) {
      throw new Error(`Destination ${newFile} is outside the project at ${rootPath}`);
    }
    const inProject = session
      .program()
      .getSourceFiles()
      .some((sourceFile) => path.resolve(sourceFile.fileName) === oldFile);
    if (!inProject) {
      throw new Error(
        `${toProjectRelative(rootPath, oldFile)} is not a file this project compiles`,
      );
    }
    // On a case-insensitive filesystem the two spellings name one file,
    // so the destination "exists" before the move has happened.
    const caseOnly =
      !ts.sys.useCaseSensitiveFileNames && oldFile.toLowerCase() === newFile.toLowerCase();
    if (!caseOnly && (ts.sys.fileExists(newFile) || ts.sys.directoryExists(newFile))) {
      throw new Error(
        `Destination ${toProjectRelative(rootPath, newFile)} already exists; ` +
          'moving onto it would destroy it',
      );
    }

    const edit = withRename(
      toWorkspaceEdit(
        session,
        session
          .languageService()
          .service.getEditsForFileRename(
            oldFile,
            newFile,
            formatSettings(session),
            userPreferences(session),
          ),
      ),
      oldFile,
      newFile,
    );
    const filesChanged = filesTouched(edit);

    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map(
      (diagnostic) => diagnostic.text,
    );

    const preview = await previewWorkspaceEdit(edit);
    const warnings = [
      ...packageEntryWarnings(rootPath, oldFile),
      ...pathAliasWarnings(
        session,
        preview.get(session.configPath) ?? ts.sys.readFile(session.configPath) ?? '',
        oldFile,
        newFile,
      ),
      ...configFileWarnings(rootPath, oldFile),
    ];

    if (input.apply !== true || newDiagnostics.length > 0) {
      return { applied: false, edit, filesChanged, newDiagnostics, warnings };
    }

    const written = await applyWorkspaceEdit(edit);
    session.invalidate({
      written: written.written,
      created: [...written.created, ...written.renamed.map((op) => op.newFile)],
      deleted: written.renamed.map((op) => op.oldFile),
    });
    return { applied: true, edit, filesChanged, newDiagnostics, warnings };
  },
};
