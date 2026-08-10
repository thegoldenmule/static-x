import { fileURLToPath } from 'node:url';
import type { Tool, WorkspaceEdit, TextEdit } from '../../../core/tool/index.js';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import { resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';

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

/**
 * `newDiagnostics` carries the collision guard's verdict: a rename that
 * would introduce a duplicate identifier or break a reference reports
 * it here instead of applying.
 */
export type RenameOutput = RefactorOutput;

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

/** LSP WorkspaceEdit (uri-keyed) -> ours (path-keyed). */
function fromLspEdit(edit: { changes?: Record<string, TextEdit[]> }): WorkspaceEdit {
  const changes: Record<string, TextEdit[]> = {};
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    changes[fileURLToPath(uri)] = edits;
  }
  return { changes };
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
      ...SYMBOL_TARGET_PROPERTIES,
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    required: ['newName'],
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(),
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
    const filesChanged = filesTouched(edit);

    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    if (!input.apply || newDiagnostics.length > 0) {
      return { applied: false, edit, filesChanged, newDiagnostics, warnings: [] };
    }

    const written = await applyWorkspaceEdit(edit);
    // Both views now disagree with disk: re-read the changed files and
    // close touched docs so the server re-reads them on next open.
    session.invalidate(written);
    for (const file of written.written) await lsp.closeDocument(file);
    return { applied: true, edit, filesChanged, newDiagnostics, warnings: [] };
  },
};
