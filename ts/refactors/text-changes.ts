import path from 'node:path';
import ts from 'typescript';
import type { Position, TextEdit, WorkspaceEdit } from '../../core/tool/index.js';
import type { TsProjectSession } from '../project/index.js';

/**
 * Converts the language service's edits into the repo's WorkspaceEdit.
 *
 * The compiler speaks offset spans (`{ span: { start, length } }`); the
 * contract speaks zero-based line/character. The conversion needs the
 * pre-edit text of each file to translate offsets, which for a file the
 * edit creates does not exist — those become a `create` file operation
 * plus one insertion at 0:0.
 */

function positionsOf(text: string): (offset: number) => Position {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return (offset) => {
    // Last line whose start is <= offset.
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low, character: offset - starts[low]! };
  };
}

/**
 * The text a file's spans are measured against: the source file the
 * program already holds, falling back to disk for a file the program
 * does not include.
 */
function textOf(session: TsProjectSession, file: string): string {
  const sourceFile = session.program().getSourceFile(file);
  if (sourceFile) return sourceFile.getFullText();
  const onDisk = ts.sys.readFile(file);
  if (onDisk === undefined) throw new Error(`Cannot read ${file} to convert its edits`);
  return onDisk;
}

export function toWorkspaceEdit(
  session: TsProjectSession,
  fileChanges: readonly ts.FileTextChanges[],
): WorkspaceEdit {
  const changes: Record<string, TextEdit[]> = {};
  const fileOps: WorkspaceEdit['fileOps'] = [];

  for (const change of fileChanges) {
    const file = path.resolve(change.fileName);
    if (change.isNewFile) {
      fileOps.push({ kind: 'create', file });
      const zero = { line: 0, character: 0 };
      changes[file] = change.textChanges.map((edit) => ({
        range: { start: zero, end: zero },
        newText: edit.newText,
      }));
      continue;
    }

    const at = positionsOf(textOf(session, file));
    const edits = change.textChanges.map((edit) => ({
      range: {
        start: at(edit.span.start),
        end: at(edit.span.start + edit.span.length),
      },
      newText: edit.newText,
    }));
    changes[file] = [...(changes[file] ?? []), ...edits];
  }

  return fileOps.length > 0 ? { changes, fileOps } : { changes };
}

/** Merge edits from separate language-service calls into one edit. */
export function mergeWorkspaceEdits(...edits: WorkspaceEdit[]): WorkspaceEdit {
  const changes: Record<string, TextEdit[]> = {};
  const fileOps: NonNullable<WorkspaceEdit['fileOps']> = [];
  for (const edit of edits) {
    for (const [file, fileEdits] of Object.entries(edit.changes)) {
      changes[file] = [...(changes[file] ?? []), ...fileEdits];
    }
    fileOps.push(...(edit.fileOps ?? []));
  }
  return fileOps.length > 0 ? { changes, fileOps } : { changes };
}
