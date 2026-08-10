import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkspaceEdit } from '../../core/tool/index.js';
import { TsProjectSession } from '../project/index.js';
import { diagnosticsIntroducedBy } from './guard.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/refactor-core-ts');
const COUNTER = path.join(FIXTURE, 'src/counter.ts');
const USES = path.join(FIXTURE, 'src/uses.ts');

const session = TsProjectSession.open(FIXTURE);
afterAll(() => session.dispose());

const at = (line: number, character: number) => ({ line, character });
const insertAt = (file: string, line: number, text: string): WorkspaceEdit => ({
  changes: { [file]: [{ range: { start: at(line, 0), end: at(line, 0) }, newText: text }] },
});

describe('diagnosticsIntroducedBy', () => {
  it('reports nothing for an edit that compiles', { timeout: 30_000 }, async () => {
    const edit = insertAt(COUNTER, 0, 'export const untouched = 1;\n');
    expect(await diagnosticsIntroducedBy(session, edit)).toEqual([]);
  });

  it('catches an error the edit introduces', async () => {
    const edit = insertAt(COUNTER, 0, 'export const wrong: number = "not a number";\n');
    const introduced = await diagnosticsIntroducedBy(session, edit);

    expect(introduced).toHaveLength(1);
    expect(introduced[0]?.code).toBe(2322);
    expect(introduced[0]?.file).toBe(COUNTER);
  });

  it('leaves the session usable afterwards, having written nothing', async () => {
    await diagnosticsIntroducedBy(session, insertAt(COUNTER, 0, 'const broken: number = "x";\n'));
    // The overlay is rolled back, so the project is clean again.
    expect(await diagnosticsIntroducedBy(session, { changes: {} })).toEqual([]);
  });

  it('typechecks a file the edit creates', async () => {
    const created = path.join(FIXTURE, 'src/created.ts');
    const edit: WorkspaceEdit = {
      changes: {
        [created]: [
          {
            range: { start: at(0, 0), end: at(0, 0) },
            newText: 'export const boom: number = "not a number";\n',
          },
        ],
      },
      fileOps: [{ kind: 'create', file: created }],
    };
    const introduced = await diagnosticsIntroducedBy(session, edit);

    // Without the created path entering the compilation this returns
    // nothing at all — the guard reporting clean on code it never
    // compiled, which is worse than having no guard.
    expect(introduced.map((d) => d.code)).toContain(2322);
    expect(introduced[0]?.file).toBe(created);
  });

  it('sees references broken by a file the edit deletes', async () => {
    const introduced = await diagnosticsIntroducedBy(session, {
      changes: {},
      fileOps: [{ kind: 'delete', file: COUNTER }],
    });

    // uses.ts imports Counter and scale from the deleted module.
    expect(introduced.some((d) => d.file === USES)).toBe(true);
  });
});
