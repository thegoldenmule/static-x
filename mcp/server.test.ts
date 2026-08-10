import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTsRegistry } from '../ts/registry.js';
import { createMcpServer } from './server.js';

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/basic-ts');

describe('MCP adapter', () => {
  const { server, ferry } = createMcpServer(createTsRegistry());
  const client = new Client({ name: 'test-client', version: '0.0.0' });

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });
  afterAll(async () => {
    await client.close();
    await server.close();
    await ferry.dispose();
  });

  it('lists every registered tool with projectRoot added to its schema', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'ts_comments_llm-tells',
      'ts_comments_long',
      'ts_comments_stale-refs',
      'ts_dupes_functions',
      'ts_graph_cycles',
      'ts_graph_dead-exports',
      'ts_refactors_rename',
    ]);
    const long = tools.find((t) => t.name === 'ts_comments_long')!;
    expect(long.inputSchema.required).toContain('projectRoot');
    expect(long.inputSchema.properties).toHaveProperty('maxLines');
  });

  it('runs a tool end-to-end through MCP', async () => {
    const result = await client.callTool({
      name: 'ts_comments_stale-refs',
      arguments: { projectRoot: FIXTURE },
    });
    const content = result.content as { type: string; text: string }[];
    const findings = JSON.parse(content[0]!.text) as { data?: { name?: string } }[];
    expect(findings.map((f) => f.data?.name).sort()).toEqual([
      'LegacyGreeter',
      'formatSalutation',
      'legacy-utils.ts',
      'makeOptions',
      'minuend',
    ]);
  });

  it('returns isError for unknown tools and missing projectRoot', async () => {
    const bad = await client.callTool({ name: 'ts_comments_long', arguments: {} });
    expect(bad.isError).toBe(true);
    const unknown = await client.callTool({
      name: 'ts_nope_nope',
      arguments: { projectRoot: FIXTURE },
    });
    expect(unknown.isError).toBe(true);
  });
});
