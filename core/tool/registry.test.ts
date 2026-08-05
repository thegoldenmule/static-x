import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry.js';
import type { Tool } from './types.js';

function fakeTool(name: string): Tool {
  return {
    name,
    description: `fake tool ${name}`,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    run: async () => ({}),
  };
}

describe('ToolRegistry', () => {
  it('registers and retrieves a tool by name', () => {
    const registry = new ToolRegistry();
    const tool = fakeTool('ts/comments/long');
    registry.register(tool);
    expect(registry.get('ts/comments/long')).toBe(tool);
    expect(registry.has('ts/comments/long')).toBe(true);
  });

  it('lists tools sorted by name', () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('ts/refactors/rename'));
    registry.register(fakeTool('ts/comments/long'));
    expect(registry.names()).toEqual(['ts/comments/long', 'ts/refactors/rename']);
    expect(registry.list().map((t) => t.name)).toEqual([
      'ts/comments/long',
      'ts/refactors/rename',
    ]);
  });

  it('rejects duplicate registration', () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('ts/comments/long'));
    expect(() => registry.register(fakeTool('ts/comments/long'))).toThrow(
      /already registered/,
    );
  });

  it('rejects names that are not path-like lowercase segments', () => {
    const registry = new ToolRegistry();
    for (const bad of ['Rename', 'ts', 'ts/', '/comments', 'ts/Comments/long', 'ts comments']) {
      expect(() => registry.register(fakeTool(bad)), bad).toThrow(/Invalid tool name/);
    }
    registry.register(fakeTool('ts/comments/stale-refs'));
  });

  it('throws a helpful error for unknown tools', () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('ts/comments/long'));
    expect(() => registry.get('ts/comments/nope')).toThrow(/Unknown tool "ts\/comments\/nope"/);
    expect(() => registry.get('ts/comments/nope')).toThrow(/ts\/comments\/long/);
  });
});
