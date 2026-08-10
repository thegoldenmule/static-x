import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyTextEdits } from '../../core/edits/index.js';
import type { WorkspaceEdit } from '../../core/tool/index.js';
import { TsProjectSession } from '../project/index.js';

/**
 * Test helpers for mutating tools. Apply-mode tests need a project they
 * are allowed to destroy, and dry-run tests need to read what an edit
 * would produce without producing it.
 */

/**
 * Copy a fixture project to a temp directory, open a session on it, and
 * clean both up afterwards. Apply-mode tests run here so a failing test
 * cannot leave the fixture rewritten.
 */
export async function withProjectCopy<T>(
  fixture: string,
  run: (session: TsProjectSession, root: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-x-refactor-'));
  await cp(fixture, dir, { recursive: true });
  const session = TsProjectSession.open(dir);
  try {
    return await run(session, dir);
  } finally {
    await session.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

/** The text a file would have if the edit were applied. */
export async function preview(edit: WorkspaceEdit, file: string): Promise<string> {
  const created = (edit.fileOps ?? []).some(
    (op) => op.kind === 'create' && path.resolve(op.file) === path.resolve(file),
  );
  const renamedFrom = (edit.fileOps ?? []).find(
    (op) => op.kind === 'rename' && path.resolve(op.newFile) === path.resolve(file),
  );
  const source = created
    ? ''
    : await readFile(
        renamedFrom?.kind === 'rename' ? renamedFrom.oldFile : file,
        'utf8',
      );
  return applyTextEdits(source, edit.changes[path.resolve(file)] ?? []);
}

/** Zero-based position of the first line containing `needle`. */
export async function positionOf(
  file: string,
  needle: string,
): Promise<{ line: number; character: number }> {
  const lines = (await readFile(file, 'utf8')).split('\n');
  for (const [line, text] of lines.entries()) {
    const character = text.indexOf(needle);
    if (character !== -1) return { line, character };
  }
  throw new Error(`"${needle}" not found in ${file}`);
}
