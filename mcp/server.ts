import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { FILES_SCHEMA, supportsFileScope } from '../core/files/index.js';
import type { JsonSchema, ToolRegistry } from '../core/tool/index.js';
import { TsFerry } from '../ts/ferry/ferry.js';

/**
 * MCP adapter over the tool registry. Tool names swap '/' for '_'
 * (MCP forbids slashes): ts/comments/long -> ts_comments_long. Every
 * MCP tool takes the underlying tool's input plus projectRoot, and
 * analysis tools also take `files` to report on a subset of the project
 * ("check what I just changed"); the ferry caches one session per root,
 * so repeated calls in a conversation reuse the language server and
 * typechecked program.
 *
 * Results are typed: MCP requires structuredContent to be a JSON
 * object, while our tools return arrays (Finding[]) or objects, so the
 * advertised outputSchema wraps each tool's own schema under a single
 * `result` property and successful calls return
 * structuredContent: { result } alongside the serialized-JSON text
 * content (the spec recommends both, for text-only clients).
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
            ...(supportsFileScope(tool) ? { files: FILES_SCHEMA } : {}),
            ...(schema.properties ?? {}),
          },
          required: ['projectRoot', ...(schema.required ?? [])],
        },
        outputSchema: {
          type: 'object' as const,
          properties: { result: tool.outputSchema },
          required: ['result'],
          additionalProperties: false,
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
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: { result },
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });

  return { server, ferry };
}
