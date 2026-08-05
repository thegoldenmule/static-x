import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type {
  Position,
  Tool,
  WorkspaceEdit,
  TextEdit,
} from '../../../core/tool/index.js';
import { applyWorkspaceEdit, previewWorkspaceEdit } from '../../../core/edits/index.js';
import { isDeclarationSite } from '../../ast/declarations.js';
import type { TsProjectSession } from '../../project/index.js';

export interface RenameInput {
  newName: string;
  /** Target by position: file plus zero-based line/character... */
  file?: string;
  line?: number;
  character?: number;
  /** ...or by declaration name, optionally disambiguated by file. */
  symbol?: string;
  /** Write the edit to disk. Default false: return the edit only. */
  apply?: boolean;
}

export interface RenameOutput {
  applied: boolean;
  edit: WorkspaceEdit;
  filesChanged: string[];
  /**
   * Diagnostics the rename would introduce (e.g. the new name collides
   * in an affected scope). Non-empty blocks apply.
   */
  newDiagnostics: string[];
}

interface Target {
  file: string;
  position: Position;
}

const IDENTIFIER = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;
// prettier-ignore
const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
]);

function isValidIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED.has(name);
}

/** Find declarations named `symbol` across the project. */
function findDeclarations(session: TsProjectSession, symbol: string, fileFilter?: string): Target[] {
  const targets: Target[] = [];
  for (const sourceFile of session.sourceFiles()) {
    if (fileFilter && !sourceFile.fileName.endsWith(fileFilter)) continue;
    const visit = (node: ts.Node) => {
      if (isDeclarationSite(node) && node.name && ts.isIdentifier(node.name) && node.name.text === symbol) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.name.getStart(sourceFile),
        );
        targets.push({ file: sourceFile.fileName, position: { line, character } });
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  return targets;
}

function resolveTarget(session: TsProjectSession, input: RenameInput): Target {
  if (input.symbol !== undefined) {
    const targets = findDeclarations(session, input.symbol, input.file);
    const files = new Set(targets.map((t) => t.file));
    if (targets.length === 0) {
      throw new Error(`No declaration named "${input.symbol}" found in project`);
    }
    if (files.size > 1) {
      const locations = targets
        .map((t) => `${t.file}:${t.position.line + 1}:${t.position.character + 1}`)
        .join('\n  ');
      throw new Error(
        `"${input.symbol}" is declared in multiple files; disambiguate with file/line/character:\n  ${locations}`,
      );
    }
    return targets[0]!; // Same-file multiples (overloads, merges) rename identically.
  }
  if (input.file === undefined || input.line === undefined || input.character === undefined) {
    throw new Error('Provide either symbol, or file + line + character');
  }
  return {
    file: path.resolve(session.rootPath, input.file),
    position: { line: input.line, character: input.character },
  };
}

/** LSP WorkspaceEdit (uri-keyed) -> ours (path-keyed). */
function fromLspEdit(edit: { changes?: Record<string, TextEdit[]> }): WorkspaceEdit {
  const changes: Record<string, TextEdit[]> = {};
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    changes[fileURLToPath(uri)] = edits;
  }
  return { changes };
}

/**
 * Typecheck the project as if the edit were applied, without touching
 * disk, and return diagnostics that are not present today. This is the
 * collision guard: a rename that introduces errors (duplicate
 * identifiers, broken references) is reported instead of applied.
 */
async function diagnosticsIntroducedBy(
  session: TsProjectSession,
  edit: WorkspaceEdit,
): Promise<string[]> {
  const newTexts = await previewWorkspaceEdit(edit);
  const before = session.program();
  const options = before.getCompilerOptions();

  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => newTexts.get(path.resolve(fileName)) ?? readFile(fileName);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => newTexts.has(path.resolve(fileName)) || fileExists(fileName);

  const after = ts.createProgram({
    rootNames: [...before.getRootFileNames()],
    options,
    host,
  });

  const describe = (d: ts.Diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    if (!d.file || d.start === undefined) return `TS${d.code}: ${message}`;
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${d.file.fileName}(${line + 1},${character + 1}): TS${d.code}: ${message}`;
  };
  // Compare by code+message only: positions legitimately shift.
  const budget = new Map<string, number>();
  for (const d of ts.getPreEmitDiagnostics(before)) {
    const key = `${d.code}:${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    budget.set(key, (budget.get(key) ?? 0) + 1);
  }
  const introduced: string[] = [];
  for (const d of ts.getPreEmitDiagnostics(after)) {
    const key = `${d.code}:${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    const remaining = budget.get(key) ?? 0;
    if (remaining > 0) budget.set(key, remaining - 1);
    else introduced.push(describe(d));
  }
  return introduced;
}

export const rename: Tool<RenameInput, RenameOutput, TsProjectSession> = {
  name: 'ts/refactors/rename',
  description:
    'Renames a symbol across the whole project via the language server, returning an ' +
    'LSP WorkspaceEdit. Targets a declaration by name (symbol) or an exact position. ' +
    'Dry-run by default; apply: true writes to disk. Refuses renames that would ' +
    'introduce compile errors, reporting them in newDiagnostics.',
  inputSchema: {
    type: 'object',
    properties: {
      newName: { type: 'string', description: 'The new identifier' },
      symbol: { type: 'string', description: 'Declaration name to rename' },
      file: { type: 'string', description: 'File path (with line/character, or to disambiguate symbol)' },
      line: { type: 'integer', minimum: 0, description: 'Zero-based line of the symbol' },
      character: { type: 'integer', minimum: 0, description: 'Zero-based character of the symbol' },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    required: ['newName'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      applied: { type: 'boolean' },
      edit: { type: 'object' },
      filesChanged: { type: 'array', items: { type: 'string' } },
      newDiagnostics: { type: 'array', items: { type: 'string' } },
    },
    required: ['applied', 'edit', 'filesChanged', 'newDiagnostics'],
  },
  async run(session, input) {
    if (!isValidIdentifier(input.newName)) {
      throw new Error(`"${input.newName}" is not a valid identifier`);
    }
    const target = resolveTarget(session, input);
    const lsp = await session.lsp();
    const uri = await session.openDocument(target.file);

    const prepared = await lsp.request<unknown>('textDocument/prepareRename', {
      textDocument: { uri },
      position: target.position,
    });
    if (prepared === null) {
      throw new Error(
        `Symbol at ${target.file}:${target.position.line + 1}:${target.position.character + 1} is not renameable`,
      );
    }

    const lspEdit = await lsp.request<{ changes?: Record<string, TextEdit[]> } | null>(
      'textDocument/rename',
      { textDocument: { uri }, position: target.position, newName: input.newName },
    );
    if (!lspEdit || Object.keys(lspEdit.changes ?? {}).length === 0) {
      throw new Error('Language server returned no edits for this rename');
    }
    const edit = fromLspEdit(lspEdit);
    const files = Object.keys(edit.changes);

    const newDiagnostics = await diagnosticsIntroducedBy(session, edit);
    if (!input.apply || newDiagnostics.length > 0) {
      return { applied: false, edit, filesChanged: files, newDiagnostics };
    }

    await applyWorkspaceEdit(edit);
    // Both views now disagree with disk: rebuild the program lazily and
    // close touched docs so the server re-reads them on next open.
    session.invalidate();
    for (const file of files) await lsp.closeDocument(file);
    return { applied: true, edit, filesChanged: files, newDiagnostics };
  },
};
