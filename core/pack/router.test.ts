import { describe, expect, it } from 'vitest';
import { FINDINGS_ARRAY_SCHEMA, ToolRegistry, type Tool } from '../tool/index.js';
import type { CheckSuite } from '../checks/index.js';
import { PackRouter } from './router.js';
import type { LanguagePack, PackFerry } from './types.js';

function tool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    outputSchema: FINDINGS_ARRAY_SCHEMA,
    run: () => Promise.resolve([]),
  };
}

interface Calls {
  seen: string[];
  disposed: number;
  built: number;
}

function pack(id: string, tools: string[], overrides: Partial<LanguagePack> = {}) {
  const calls: Calls = { seen: [], disposed: 0, built: 0 };
  const suite: Record<string, CheckSuite> = {
    commit: { novelty: 'changed-lines', tools: { [tools[0] ?? `${id}/x`]: { level: 'warn' } } },
  };
  const ferry: PackFerry = {
    call: (toolName) => {
      calls.seen.push(toolName);
      return Promise.resolve(`${id}:${toolName}`);
    },
    dispose: () => {
      calls.disposed++;
      return Promise.resolve();
    },
  };
  const value: LanguagePack = {
    id,
    label: id.toUpperCase(),
    sourceExtensions: new Set([`.${id}`]),
    projectRootHint: `${id} root`,
    defaultChecks: suite,
    fixableCodes: new Set([`${id}.fixable`]),
    binds: () => true,
    createRegistry: () => {
      const registry = new ToolRegistry();
      for (const name of tools) registry.register(tool(name));
      return registry;
    },
    createFerry: () => {
      calls.built++;
      return ferry;
    },
    ...overrides,
  };
  return { pack: value, calls };
}

describe('PackRouter', () => {
  it('merges every pack’s tools into one registry', () => {
    const router = new PackRouter([pack('ts', ['ts/a', 'ts/b']).pack, pack('sw', ['sw/a']).pack]);
    expect(router.registry.names()).toEqual(['sw/a', 'ts/a', 'ts/b']);
  });

  it('routes a call to the pack named by the first path segment', async () => {
    const ts = pack('ts', ['ts/a']);
    const sw = pack('sw', ['sw/a']);
    const router = new PackRouter([ts.pack, sw.pack]);
    await expect(router.call('sw/a', '/p', {})).resolves.toBe('sw:sw/a');
    expect(ts.calls.seen).toEqual([]);
    expect(sw.calls.seen).toEqual(['sw/a']);
  });

  // Building a ferry is what starts a language server, so a repository
  // that never calls a pack must never pay for one.
  it('builds a pack’s ferry only when a call reaches it', async () => {
    const ts = pack('ts', ['ts/a']);
    const sw = pack('sw', ['sw/a']);
    const router = new PackRouter([ts.pack, sw.pack]);
    expect(sw.calls.built).toBe(0);
    await router.call('ts/a', '/p', {});
    expect(ts.calls.built).toBe(1);
    expect(sw.calls.built).toBe(0);
    await router.call('ts/a', '/p', {});
    expect(ts.calls.built).toBe(1);
  });

  it('disposes only the ferries it built', async () => {
    const ts = pack('ts', ['ts/a']);
    const sw = pack('sw', ['sw/a']);
    const router = new PackRouter([ts.pack, sw.pack]);
    await router.call('ts/a', '/p', {});
    await router.dispose();
    expect(ts.calls.disposed).toBe(1);
    expect(sw.calls.disposed).toBe(0);
  });

  it('rejects a tool whose name could not route back to its pack', () => {
    expect(() => new PackRouter([pack('ts', ['sw/a']).pack])).toThrow(/could not be routed/);
  });

  it('rejects two packs claiming one id', () => {
    expect(() => new PackRouter([pack('ts', ['ts/a']).pack, pack('ts', ['ts/b']).pack])).toThrow(
      /claim the id/,
    );
  });

  // A suite name is an event, not a language: two packs merging into
  // `commit` must filter it the same way or one would silently win.
  it('rejects packs that disagree on a shared suite’s novelty', () => {
    const sw = pack('sw', ['sw/a'], {
      defaultChecks: { commit: { novelty: 'baseline', tools: { 'sw/a': { level: 'warn' } } } },
    });
    expect(() => new PackRouter([pack('ts', ['ts/a']).pack, sw.pack])).toThrow(/disagree/);
  });

  it('merges same-named suites and unions codes and extensions', () => {
    const router = new PackRouter([pack('ts', ['ts/a']).pack, pack('sw', ['sw/a']).pack]);
    expect(router.defaultChecks()['commit']).toEqual({
      novelty: 'changed-lines',
      tools: { 'ts/a': { level: 'warn' }, 'sw/a': { level: 'warn' } },
    });
    expect([...router.fixableCodes()].sort()).toEqual(['sw.fixable', 'ts.fixable']);
    expect([...router.sourceExtensions()].sort()).toEqual(['.sw', '.ts']);
  });

  it('reports which packs bind a given root', () => {
    const sw = pack('sw', ['sw/a'], { binds: () => false });
    const router = new PackRouter([pack('ts', ['ts/a']).pack, sw.pack]);
    expect(router.bindingPacks('/p').map((p) => p.id)).toEqual(['ts']);
  });
});
