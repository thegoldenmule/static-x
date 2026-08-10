import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FINDINGS_ARRAY_SCHEMA, ToolRegistry, type ProjectSession, type Tool } from '../../core/tool/index.js';
import type { TsProjectSession } from '../project/index.js';
import { TsFerry } from './ferry.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/basic-ts');

const seenSessions: ProjectSession[] = [];
const echoTool: Tool = {
  name: 'ts/testing/echo',
  description: 'echoes the session root, for ferry tests',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  run: (session, input) => {
    seenSessions.push(session);
    return Promise.resolve({ root: session.rootPath, input });
  },
};

/** Reports the target files it was given, one finding each. */
const targetsTool: Tool = {
  name: 'ts/testing/targets',
  description: 'reports one finding per target file, for scope tests',
  inputSchema: { type: 'object' },
  outputSchema: FINDINGS_ARRAY_SCHEMA,
  run: async (session, input) => {
    const { delayMs } = input as { delayMs?: number };
    if (delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return (session as TsProjectSession).targetFiles().map((sourceFile) => ({
      file: sourceFile.fileName,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      code: 'testing.target',
      message: 'a target file',
      severity: 'info' as const,
    }));
  },
};

describe('TsFerry', () => {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  registry.register(targetsTool);
  const ferry = new TsFerry(registry);
  afterAll(() => ferry.dispose());

  it('dispatches a call to the named tool with a bound session', async () => {
    const result = await ferry.call('ts/testing/echo', FIXTURE, { n: 1 });
    expect(result).toEqual({ root: FIXTURE, input: { n: 1 } });
  });

  it('reuses the session for repeated calls on the same root', async () => {
    await ferry.call('ts/testing/echo', FIXTURE, {});
    await ferry.call('ts/testing/echo', path.join(FIXTURE, '.'), {});
    expect(seenSessions.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seenSessions).size).toBe(1);
  });

  it('rejects unknown tools without creating sessions', async () => {
    await expect(ferry.call('ts/testing/nope', FIXTURE, {})).rejects.toThrow(/Unknown tool/);
  });

  describe('files scope', () => {
    const basenames = (result: unknown): string[] =>
      (result as { file: string }[]).map((f) => path.basename(f.file)).sort();

    it('narrows the files a tool reports on', async () => {
      const scoped = await ferry.call('ts/testing/targets', FIXTURE, {
        files: ['src/math.ts', 'src/notes.ts'],
      });
      expect(basenames(scoped)).toEqual(['math.ts', 'notes.ts']);
    });

    it('reports the whole project when no scope is given', async () => {
      const all = await ferry.call('ts/testing/targets', FIXTURE, {});
      expect(basenames(all).length).toBeGreaterThan(2);
    });

    it('keeps the reserved key out of the tool input', async () => {
      const result = await ferry.call('ts/testing/targets', FIXTURE, {
        files: ['src/math.ts'],
        delayMs: 0,
      });
      expect(basenames(result)).toEqual(['math.ts']);
      const echoed = (await ferry.call('ts/testing/echo', FIXTURE, { n: 1 })) as {
        input: Record<string, unknown>;
      };
      expect(echoed.input).toEqual({ n: 1 });
    });

    it('ignores paths naming no project file, so raw git output is safe to pass', async () => {
      const scoped = await ferry.call('ts/testing/targets', FIXTURE, {
        files: ['src/math.ts', 'src/deleted.ts', 'docs/notes.md'],
      });
      expect(basenames(scoped)).toEqual(['math.ts']);
    });

    it('answers a source-free scope without opening the project', async () => {
      expect(await ferry.call('ts/testing/targets', '/no/such/project', {
        files: ['README.md'],
      })).toEqual([]);
      expect(await ferry.call('ts/testing/targets', '/no/such/project', { files: [] })).toEqual([]);
    });

    it('refuses to scope a tool that rewrites code', async () => {
      await expect(
        ferry.call('ts/testing/echo', FIXTURE, { files: ['src/math.ts'] }),
      ).rejects.toThrow(/cannot be scoped/);
    });

    it('rejects a files value that is not a list of paths', async () => {
      await expect(ferry.call('ts/testing/targets', FIXTURE, { files: 'src/math.ts' })).rejects.toThrow(
        /must be an array of paths/,
      );
    });

    it('never leaks one call\'s scope into another running against the same session', async () => {
      const [slow, fast] = await Promise.all([
        ferry.call('ts/testing/targets', FIXTURE, { files: ['src/math.ts'], delayMs: 20 }),
        ferry.call('ts/testing/targets', FIXTURE, { files: ['src/notes.ts'] }),
      ]);
      expect(basenames(slow)).toEqual(['math.ts']);
      expect(basenames(fast)).toEqual(['notes.ts']);
    });
  });
});
