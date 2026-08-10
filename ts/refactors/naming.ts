import path from 'node:path';
import ts from 'typescript';
import type { TextEdit, WorkspaceEdit } from '../../core/tool/index.js';
import type { TsProjectSession } from '../project/index.js';

/**
 * Giving an extracted symbol the name the caller asked for.
 *
 * TypeScript names what it extracts `newFunction` or `NewType` and
 * reports the offset where a user would start typing. Renaming from
 * that point rather than substituting text means the declaration and
 * every reference move together, and it is the compiler deciding what
 * counts as a reference.
 *
 * The wrinkle is coordinates: the rename location is an offset into the
 * POST-edit text, while a WorkspaceEdit is expressed against the file
 * as it is now. So the edits record where each inserted chunk lands,
 * and the rename is folded back into those chunks — rather than the
 * whole file being emitted as one opaque replacement.
 */

/** Offset of a position in `text`, for edits expressed in line/character. */
function offsetsOf(text: string): (line: number, character: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return (line, character) => Math.min((starts[line] ?? text.length) + character, text.length);
}

interface PlacedEdit {
  edit: TextEdit;
  /** Where this edit's newText landed in the post-edit text. */
  start: number;
  end: number;
}

/**
 * Apply edits left to right, recording where each inserted chunk ends
 * up. The placement is what lets a rename computed against the post-edit
 * text be folded back into the edits themselves, instead of being
 * emitted as an opaque whole-file replacement.
 */
function place(text: string, edits: readonly TextEdit[]): { text: string; placed: PlacedEdit[] } {
  const at = offsetsOf(text);
  const ordered = [...edits].sort(
    (a, b) =>
      at(a.range.start.line, a.range.start.character) -
      at(b.range.start.line, b.range.start.character),
  );

  let result = '';
  let read = 0;
  const placed: PlacedEdit[] = [];
  for (const edit of ordered) {
    const start = at(edit.range.start.line, edit.range.start.character);
    const end = at(edit.range.end.line, edit.range.end.character);
    result += text.slice(read, start);
    placed.push({ edit, start: result.length, end: result.length + edit.newText.length });
    result += edit.newText;
    read = end;
  }
  result += text.slice(read);
  return { text: result, placed };
}

/**
 * Give the extracted symbol the caller's name.
 *
 * TypeScript names it `newFunction` and hands back the offset where a
 * user would start typing. Renaming through the language service rather
 * than substituting text means the declaration and every reference move
 * together, and it is the compiler deciding what counts as a reference.
 * The placeholder is a fresh identifier, so every rename location falls
 * inside the text this edit inserts; one that did not would mean the
 * rename had reached pre-existing code, which is a refusal rather than
 * something to patch around.
 */
export function withName(
  session: TsProjectSession,
  edit: WorkspaceEdit,
  file: string,
  renameOffset: number,
  newName: string,
): WorkspaceEdit {
  const sourceFile = session.program().getSourceFile(file);
  if (!sourceFile) throw new Error(`${file} left the project mid-refactor`);
  const edits = edit.changes[file] ?? [];
  const { text, placed } = place(sourceFile.getFullText(), edits);

  const service = session.languageService();
  const restore = service.overlay(new Map([[file, text]]));
  let locations: readonly ts.RenameLocation[];
  try {
    locations =
      service.service.findRenameLocations(file, renameOffset, false, false, {}) ?? [];
  } finally {
    restore();
  }
  if (locations.length === 0) {
    throw new Error(`Could not rename the extracted symbol to "${newName}"`);
  }

  const rewritten = new Map(placed.map((entry) => [entry, entry.edit.newText]));
  for (const location of locations) {
    if (path.resolve(location.fileName) !== file) {
      throw new Error(`Renaming the extracted symbol reached ${location.fileName}`);
    }
    const { start, length } = location.textSpan;
    const owner = placed.find((entry) => start >= entry.start && start + length <= entry.end);
    if (!owner) {
      throw new Error(
        'Renaming the extracted symbol would change code outside the extraction; ' +
          `leaving it as TypeScript named it`,
      );
    }
    const current = rewritten.get(owner)!;
    const local = start - owner.start;
    rewritten.set(owner, current.slice(0, local) + newName + current.slice(local + length));
  }

  return {
    ...edit,
    changes: {
      ...edit.changes,
      [file]: placed.map((entry) => ({ range: entry.edit.range, newText: rewritten.get(entry)! })),
    },
  };
}
