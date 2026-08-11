import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTsRegistry } from '../ts/registry.js';
import { createMcpServer } from './server.js';

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/basic-ts');

describe('MCP adapter', () => {
  const registry = createTsRegistry();
  const { server, ferry } = createMcpServer(registry);
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
      'ts_async_floating-promises',
      'ts_comments_llm-tells',
      'ts_comments_long',
      'ts_comments_stale-refs',
      'ts_dupes_functions',
      'ts_graph_cycles',
      'ts_graph_dead-exports',
      'ts_refactors_change-signature',
      'ts_refactors_constructor-to-factory',
      'ts_refactors_enum-to-const-object',
      'ts_refactors_extract',
      'ts_refactors_extract-class',
      'ts_refactors_extract-interface',
      'ts_refactors_extract-superclass',
      'ts_refactors_extract-type',
      'ts_refactors_inline-field',
      'ts_refactors_inline-function',
      'ts_refactors_inline-parameter',
      'ts_refactors_inline-type-alias',
      'ts_refactors_inline-variable',
      'ts_refactors_introduce-parameter',
      'ts_refactors_invert-boolean',
      'ts_refactors_make-readonly',
      'ts_refactors_member-form',
      'ts_refactors_module-form',
      'ts_refactors_move-file',
      'ts_refactors_move-instance-method',
      'ts_refactors_move-member',
      'ts_refactors_move-symbol',
      'ts_refactors_pull-members-up',
      'ts_refactors_push-members-down',
      'ts_refactors_rename',
      'ts_refactors_safe-delete',
      'ts_refactors_static-form',
      'ts_refactors_widen-type',
      'ts_types_loopholes',
    ]);
    const long = tools.find((t) => t.name === 'ts_comments_long')!;
    expect(long.inputSchema.required).toContain('projectRoot');
    expect(long.inputSchema.properties).toHaveProperty('maxLines');
  });

  it('offers files on analysis tools and withholds it from refactors', async () => {
    const { tools } = await client.listTools();
    const long = tools.find((t) => t.name === 'ts_comments_long')!;
    expect(long.inputSchema.properties).toHaveProperty('files');
    expect(long.inputSchema.required).not.toContain('files');

    // Every refactor rewrites code project-wide, so a partial file list
    // would mean a partial refactor. None of them may offer `files`.
    const refactors = tools.filter((t) => t.name.startsWith('ts_refactors_'));
    expect(refactors.length).toBeGreaterThan(1);
    for (const refactor of refactors) {
      expect(refactor.inputSchema.properties, refactor.name).not.toHaveProperty('files');
    }
  });

  it('scopes a call to the files it is given', async () => {
    const result = await client.callTool({
      name: 'ts_comments_stale-refs',
      arguments: { projectRoot: FIXTURE, files: ['src/literals.ts'] },
    });
    const content = result.content as { type: string; text: string }[];
    const findings = JSON.parse(content[0]!.text) as { data?: { name?: string } }[];
    expect(findings.map((f) => f.data?.name).sort()).toEqual(['legacy-utils.ts', 'makeOptions']);
  });

  it('advertises each tool output wrapped in a result-object schema', async () => {
    const { tools } = await client.listTools();
    const cycles = tools.find((t) => t.name === 'ts_graph_cycles')!;
    expect(cycles.outputSchema).toEqual({
      type: 'object',
      properties: { result: registry.get('ts/graph/cycles').outputSchema },
      required: ['result'],
      additionalProperties: false,
    });
    const rename = tools.find((t) => t.name === 'ts_refactors_rename')!;
    expect(rename.outputSchema).toEqual({
      type: 'object',
      properties: { result: registry.get('ts/refactors/rename').outputSchema },
      required: ['result'],
      additionalProperties: false,
    });
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
    expect(result.structuredContent).toEqual({ result: findings });
  });

  it('returns isError for unknown tools and missing projectRoot', async () => {
    const bad = await client.callTool({ name: 'ts_comments_long', arguments: {} });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toBeUndefined();
    const unknown = await client.callTool({
      name: 'ts_nope_nope',
      arguments: { projectRoot: FIXTURE },
    });
    expect(unknown.isError).toBe(true);
  });
});
