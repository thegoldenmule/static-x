import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchema, ToolRegistry } from '../core/tool/index.js';
import { TsFerry } from '../ts/ferry/ferry.js';

/**
 * MCP adapter over the tool registry. Tool names swap '/' for '_'
 * (MCP forbids slashes): ts/comments/long -> ts_comments_long. Every
 * MCP tool takes the underlying tool's input plus projectRoot; the
 * ferry caches one session per root, so repeated calls in a
 * conversation reuse the language server and typechecked program.
 */
export function createMcpServer(registry: ToolRegistry): { server: Server; ferry: TsFerry } {
  const ferry = new TsFerry(registry);
  const server = new Server(
    { name: 'static-x', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  const mcpName = (name: string) => name.replaceAll('/', '_');
  const registryName = (name: string) => name.replaceAll('_', '/');

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: registry.list().map((tool) => {
      const schema = tool.inputSchema as { properties?: Record<string, JsonSchema>; required?: string[] };
      return {
        name: mcpName(tool.name),
        description: tool.description,
        inputSchema: {
          type: 'object' as const,
          properties: {
            projectRoot: {
              type: 'string',
              description: 'Absolute path of the project to analyze (its root or any dir containing tsconfig.json)',
            },
            ...(schema.properties ?? {}),
          },
          required: ['projectRoot', ...(schema.required ?? [])],
        },
      };
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { projectRoot, ...input } = (request.params.arguments ?? {}) as {
      projectRoot?: string;
    } & Record<string, unknown>;
    try {
      if (typeof projectRoot !== 'string' || projectRoot === '') {
        throw new Error('projectRoot (string) is required');
      }
      const result = await ferry.call(registryName(request.params.name), projectRoot, input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });

  return { server, ferry };
}
