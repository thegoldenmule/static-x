import { readFile, writeFile } from 'node:fs/promises';
import type { Position, TextEdit, WorkspaceEdit } from '../tool/index.js';

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function offsetAt(starts: number[], text: string, position: Position): number {
  const lineStart = starts[position.line];
  if (lineStart === undefined) {
    throw new Error(`Edit position line ${position.line} is past end of file`);
  }
  return Math.min(lineStart + position.character, text.length);
}

/** Apply LSP-style text edits to a document. Edits must not overlap. */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const starts = lineStarts(text);
  const resolved = edits
    .map((edit) => ({
      start: offsetAt(starts, text, edit.range.start),
      end: offsetAt(starts, text, edit.range.end),
      newText: edit.newText,
    }))
    .sort((a, b) => b.start - a.start || b.end - a.end);

  let result = text;
  let previousStart = Infinity;
  for (const edit of resolved) {
    if (edit.end > previousStart) {
      throw new Error('Overlapping text edits');
    }
    previousStart = edit.start;
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  return result;
}

/**
 * Compute the post-edit text of every file a WorkspaceEdit touches,
 * without writing anything. Keys are absolute file paths.
 */
export async function previewWorkspaceEdit(edit: WorkspaceEdit): Promise<Map<string, string>> {
  const preview = new Map<string, string>();
  for (const [file, edits] of Object.entries(edit.changes)) {
    preview.set(file, applyTextEdits(await readFile(file, 'utf8'), edits));
  }
  return preview;
}

/** Write a WorkspaceEdit to disk. Returns the paths of changed files. */
export async function applyWorkspaceEdit(edit: WorkspaceEdit): Promise<string[]> {
  const preview = await previewWorkspaceEdit(edit);
  for (const [file, text] of preview) {
    await writeFile(file, text, 'utf8');
  }
  return [...preview.keys()];
}
