import path from 'node:path';
import ts from 'typescript';
import { previewWorkspaceEdit } from '../../core/edits/index.js';
import type { WorkspaceEdit } from '../../core/tool/index.js';
import type { TsProjectSession } from '../project/index.js';

/**
 * The safety net under every mutating tool: typecheck the project as if
 * the edit were applied, without touching disk, and report diagnostics
 * that are not present today.
 *
 * A refactor that introduces a compile error is refused rather than
 * written, which is what makes a dry-run worth reading — the caller
 * learns the edit is sound, not just what it would say.
 *
 * The guard is only as wide as the compilation. A file the edit creates
 * has to enter the program, or its contents are never checked and the
 * guard reports clean on code it never compiled; a file the edit
 * deletes has to leave it, or references the deletion broke still
 * resolve. Both are handled by the language service's overlay.
 */

export interface Diagnostic {
  file?: string;
  line?: number;
  character?: number;
  code: number;
  message: string;
  /** `file(line,col): TSxxxx: message`, the form tools report. */
  text: string;
}

function describe(diagnostic: ts.Diagnostic): Diagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
  if (!diagnostic.file || diagnostic.start === undefined) {
    return { code: diagnostic.code, message, text: `TS${diagnostic.code}: ${message}` };
  }
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    file: diagnostic.file.fileName,
    line,
    character,
    code: diagnostic.code,
    message,
    text: `${diagnostic.file.fileName}(${line + 1},${character + 1}): TS${diagnostic.code}: ${message}`,
  };
}

/** Compare by code+message only: positions legitimately shift. */
function budgetOf(diagnostics: readonly ts.Diagnostic[]): Map<string, number> {
  const budget = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
    budget.set(key, (budget.get(key) ?? 0) + 1);
  }
  return budget;
}

/**
 * Diagnostics the edit would introduce. Empty means the edit compiles
 * as well as the project does today — including files it creates.
 */
export async function diagnosticsIntroducedBy(
  session: TsProjectSession,
  edit: WorkspaceEdit,
): Promise<Diagnostic[]> {
  const service = session.languageService();
  const before = budgetOf(ts.getPreEmitDiagnostics(service.program()));

  const preview = await previewWorkspaceEdit(edit);
  const removed = (edit.fileOps ?? []).flatMap((op) =>
    op.kind === 'delete'
      ? [path.resolve(op.file)]
      : op.kind === 'rename'
        ? [path.resolve(op.oldFile)]
        : [],
  );

  const restore = service.overlay(preview, removed);
  let introduced: Diagnostic[];
  try {
    introduced = [];
    for (const diagnostic of ts.getPreEmitDiagnostics(service.program())) {
      const key = `${diagnostic.code}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
      const remaining = before.get(key) ?? 0;
      if (remaining > 0) before.set(key, remaining - 1);
      else introduced.push(describe(diagnostic));
    }
  } finally {
    restore();
  }
  return introduced;
}
