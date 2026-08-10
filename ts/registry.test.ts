import { describe, expect, it } from 'vitest';
import { createTsRegistry } from './registry.js';

describe('createTsRegistry', () => {
  it('registers every tool with a self-contained outputSchema (no dangling $ref)', () => {
    const tools = createTsRegistry().list();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      // A $ref into a definitions block no adapter ships would be
      // unresolvable for any consumer compiling the schema standalone.
      expect(JSON.stringify(tool.outputSchema), tool.name).not.toContain('$ref');
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain('$ref');
    }
  });
});
