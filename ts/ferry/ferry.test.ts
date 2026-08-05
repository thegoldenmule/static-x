import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ToolRegistry, type ProjectSession, type Tool } from '../../core/tool/index.js';
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

describe('TsFerry', () => {
  const registry = new ToolRegistry();
  registry.register(echoTool);
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
});
