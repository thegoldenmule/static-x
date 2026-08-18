import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileOperation, Position, TextEdit, WorkspaceEdit } from '../tool/index.js';
import { lineStartsOf } from '../text/index.js';

function offsetAt(starts: number[], text: string, position: Position): number {
  const lineStart = starts[position.line];
  if (lineStart === undefined) {
    throw new Error(`Edit position line ${position.line} is past end of file`);
  }
  return Math.min(lineStart + position.character, text.length);
}

/** Apply LSP-style text edits to a document. Edits must not overlap. */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const starts = lineStartsOf(text);
  const resolved = edits
    .map((edit) => ({
      start: offsetAt(starts, text, edit.range.start),
      end: offsetAt(starts, text, edit.range.end),
      newText: edit.newText,
    }))
    .sort((a, b) => b.start - a.start || b.end - a.end);

  let result = text;
  let previousStart = Infinity;
  let previous: (typeof resolved)[number] | undefined;
  for (const edit of resolved) {
    if (edit.end > previousStart) {
      // Naming the pair matters: two passes that each edit an import
      // clause produce this, and "overlapping text edits" alone leaves
      // the caller to guess which of a hundred edits collided.
      const show = (candidate: { start: number; end: number; newText: string }) =>
        `[${candidate.start}, ${candidate.end}) -> ${JSON.stringify(
          candidate.newText.length > 40 ? `${candidate.newText.slice(0, 40)}…` : candidate.newText,
        )}`;
      throw new Error(
        `Overlapping text edits: ${show(edit)} overlaps ${previous ? show(previous) : '(none)'}`,
      );
    }
    previousStart = edit.start;
    previous = edit;
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  return result;
}

/**
 * Where a file's pre-edit content comes from. `changes` keys name paths
 * in the post-fileOps tree — the same convention the TypeScript
 * language service uses when it reports edits for a file it is also
 * moving — so a renamed file's edits are keyed by its new path while
 * its text still has to be read from the old one, and a created file
 * has no text to read at all.
 */
function sourceOf(file: string, ops: readonly FileOperation[]): string | undefined {
  for (const op of ops) {
    if (op.kind === 'rename' && path.resolve(op.newFile) === file) return path.resolve(op.oldFile);
    if (op.kind === 'create' && path.resolve(op.file) === file) return undefined;
  }
  return file;
}

function createdText(file: string, ops: readonly FileOperation[]): string | undefined {
  for (const op of ops) {
    if (op.kind === 'create' && path.resolve(op.file) === file) return op.text ?? '';
  }
  return undefined;
}

/**
 * Compute the post-edit text of every file a WorkspaceEdit touches,
 * without writing anything. Keys are absolute file paths in the tree
 * the edit produces — a created or renamed file appears under its new
 * path. Files the edit deletes are absent.
 */
export async function previewWorkspaceEdit(edit: WorkspaceEdit): Promise<Map<string, string>> {
  const ops = edit.fileOps ?? [];
  const deleted = new Set(
    ops.filter((op) => op.kind === 'delete').map((op) => path.resolve(op.file)),
  );

  const preview = new Map<string, string>();
  const read = async (file: string): Promise<string> => {
    const created = createdText(file, ops);
    if (created !== undefined) return created;
    const source = sourceOf(file, ops);
    return source === undefined ? '' : readFile(source, 'utf8');
  };

  for (const [key, edits] of Object.entries(edit.changes)) {
    const file = path.resolve(key);
    if (deleted.has(file)) continue;
    preview.set(file, applyTextEdits(await read(file), edits));
  }
  // Files the edit creates or renames without editing still have content.
  for (const op of ops) {
    const file = op.kind === 'create' ? path.resolve(op.file) : op.kind === 'rename' ? path.resolve(op.newFile) : undefined;
    if (file === undefined || preview.has(file) || deleted.has(file)) continue;
    preview.set(file, await read(file));
  }
  return preview;
}

export interface AppliedEdit {
  /** Every path written, in the post-edit tree. */
  written: string[];
  created: string[];
  renamed: { oldFile: string; newFile: string }[];
  deleted: string[];
}

/**
 * A rename that differs only in case is not a move on a
 * case-insensitive filesystem — writing the new path would land on the
 * same file and removing the old one would take the content with it —
 * so it goes through a temporary path.
 */
async function renameFile(oldFile: string, newFile: string): Promise<void> {
  await mkdir(path.dirname(newFile), { recursive: true });
  if (oldFile.toLowerCase() !== newFile.toLowerCase()) {
    await rename(oldFile, newFile);
    return;
  }
  const via = `${newFile}.static-x-${process.pid}.tmp`;
  await rename(oldFile, via);
  await rename(via, newFile);
}

/**
 * Write a WorkspaceEdit to disk: renames first, so the paths the text
 * edits are keyed by exist; then content; then deletions.
 */
export async function applyWorkspaceEdit(edit: WorkspaceEdit): Promise<AppliedEdit> {
  const ops = edit.fileOps ?? [];
  const preview = await previewWorkspaceEdit(edit);

  const renamed: { oldFile: string; newFile: string }[] = [];
  for (const op of ops) {
    if (op.kind !== 'rename') continue;
    const oldFile = path.resolve(op.oldFile);
    const newFile = path.resolve(op.newFile);
    await renameFile(oldFile, newFile);
    renamed.push({ oldFile, newFile });
  }

  const created: string[] = [];
  for (const op of ops) {
    if (op.kind === 'create') created.push(path.resolve(op.file));
  }

  for (const [file, text] of preview) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
  }

  const deleted: string[] = [];
  for (const op of ops) {
    if (op.kind !== 'delete') continue;
    const file = path.resolve(op.file);
    await rm(file, { force: true });
    deleted.push(file);
  }

  return { written: [...preview.keys()], created, renamed, deleted };
}
