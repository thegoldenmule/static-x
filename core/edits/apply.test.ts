import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyTextEdits, applyWorkspaceEdit, previewWorkspaceEdit } from './apply.js';
import type { WorkspaceEdit } from '../tool/index.js';

const at = (line: number, character: number) => ({ line, character });
const span = (l1: number, c1: number, l2: number, c2: number) => ({
  start: at(l1, c1),
  end: at(l2, c2),
});

let dir: string | undefined;

async function project(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(path.join(os.tmpdir(), 'static-x-edits-'));
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
  }
  return dir;
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('applyTextEdits', () => {
  it('applies non-overlapping edits regardless of order', () => {
    const text = 'alpha\nbeta\ngamma\n';
    expect(
      applyTextEdits(text, [
        { range: span(2, 0, 2, 5), newText: 'GAMMA' },
        { range: span(0, 0, 0, 5), newText: 'ALPHA' },
      ]),
    ).toBe('ALPHA\nbeta\nGAMMA\n');
  });

  it('rejects overlapping edits rather than silently picking one', () => {
    expect(() =>
      applyTextEdits('abcdef\n', [
        { range: span(0, 0, 0, 4), newText: 'x' },
        { range: span(0, 2, 0, 6), newText: 'y' },
      ]),
    ).toThrow(/Overlapping/);
  });
});

describe('previewWorkspaceEdit', () => {
  it('reads a created file as empty instead of failing on it', async () => {
    const root = await project({ 'a.ts': 'export const a = 1;\n' });
    const created = path.join(root, 'b.ts');
    const edit: WorkspaceEdit = {
      changes: { [created]: [{ range: span(0, 0, 0, 0), newText: 'export const b = 2;\n' }] },
      fileOps: [{ kind: 'create', file: created }],
    };
    expect((await previewWorkspaceEdit(edit)).get(created)).toBe('export const b = 2;\n');
  });

  it('reads a renamed file from its old path, keyed by its new one', async () => {
    const root = await project({ 'old.ts': "import './x.js';\n" });
    const oldFile = path.join(root, 'old.ts');
    const newFile = path.join(root, 'sub/new.ts');
    const edit: WorkspaceEdit = {
      changes: { [newFile]: [{ range: span(0, 7, 0, 15), newText: "'../x.js'" }] },
      fileOps: [{ kind: 'rename', oldFile, newFile }],
    };
    const preview = await previewWorkspaceEdit(edit);
    expect(preview.get(newFile)).toBe("import '../x.js';\n");
    expect(preview.has(oldFile)).toBe(false);
  });

  it('omits files the edit deletes', async () => {
    const root = await project({ 'gone.ts': 'export const gone = 1;\n' });
    const gone = path.join(root, 'gone.ts');
    const preview = await previewWorkspaceEdit({ changes: {}, fileOps: [{ kind: 'delete', file: gone }] });
    expect(preview.has(gone)).toBe(false);
  });
});

describe('applyWorkspaceEdit', () => {
  it('renames before writing, so edits land at the new path', async () => {
    const root = await project({
      'src/lib.ts': "import './sibling.js';\nexport const lib = 1;\n",
      'src/sibling.ts': 'export const sibling = 1;\n',
      'src/app.ts': "import { lib } from './lib.js';\nexport const app = lib;\n",
    });
    const oldFile = path.join(root, 'src/lib.ts');
    const newFile = path.join(root, 'src/core/lib.ts');
    const app = path.join(root, 'src/app.ts');

    const result = await applyWorkspaceEdit({
      changes: {
        [newFile]: [{ range: span(0, 7, 0, 21), newText: "'../sibling.js'" }],
        [app]: [{ range: span(0, 20, 0, 30), newText: "'./core/lib.js'" }],
      },
      fileOps: [{ kind: 'rename', oldFile, newFile }],
    });

    expect(await readFile(newFile, 'utf8')).toBe("import '../sibling.js';\nexport const lib = 1;\n");
    expect(await readFile(app, 'utf8')).toContain("'./core/lib.js'");
    await expect(readFile(oldFile, 'utf8')).rejects.toThrow();
    expect(result.renamed).toEqual([{ oldFile, newFile }]);
  });

  it('survives a case-only rename on a case-insensitive filesystem', async () => {
    const root = await project({ 'src/Widget.ts': 'export const widget = 1;\n' });
    const oldFile = path.join(root, 'src/Widget.ts');
    const newFile = path.join(root, 'src/widget.ts');

    await applyWorkspaceEdit({ changes: {}, fileOps: [{ kind: 'rename', oldFile, newFile }] });

    expect(await readFile(newFile, 'utf8')).toBe('export const widget = 1;\n');
  });

  it('creates files, including directories that do not exist yet', async () => {
    const root = await project({ 'a.ts': 'export const a = 1;\n' });
    const created = path.join(root, 'deep/nested/b.ts');

    const result = await applyWorkspaceEdit({
      changes: { [created]: [{ range: span(0, 0, 0, 0), newText: 'export const b = 2;\n' }] },
      fileOps: [{ kind: 'create', file: created }],
    });

    expect(await readFile(created, 'utf8')).toBe('export const b = 2;\n');
    expect(result.created).toEqual([created]);
  });

  it('deletes last, so a file can be edited and removed in one edit', async () => {
    const root = await project({
      'keep.ts': 'export const keep = 1;\n',
      'gone.ts': 'export const gone = 1;\n',
    });
    const keep = path.join(root, 'keep.ts');
    const gone = path.join(root, 'gone.ts');

    const result = await applyWorkspaceEdit({
      changes: { [keep]: [{ range: span(0, 13, 0, 17), newText: 'kept' }] },
      fileOps: [{ kind: 'delete', file: gone }],
    });

    expect(await readFile(keep, 'utf8')).toBe('export const kept = 1;\n');
    await expect(readFile(gone, 'utf8')).rejects.toThrow();
    expect(result.deleted).toEqual([gone]);
  });
});
