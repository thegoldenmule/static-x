import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { FILES_SCHEMA, supportsFileScope } from '../core/files/index.js';
import type { JsonSchema } from '../core/tool/index.js';
import { PackRouter } from '../core/pack/index.js';

/**
 * MCP adapter over the router's registry. Tool names swap '/' for '_'
 * (MCP forbids slashes): ts/comments/long -> ts_comments_long. The
 * round-trip is lossless because the registry's name pattern admits no
 * underscore, which mcpNames() asserts rather than assumes. Every
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
export function createMcpServer(router: PackRouter): { server: Server; router: PackRouter } {
  const { registry } = router;
  const byMcpName = mcpNames(registry.names());
  const server = new Server(
    { name: 'static-x', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );


  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: registry.list().map((tool) => {
      const schema = tool.inputSchema as { properties?: Record<string, JsonSchema>; required?: string[] };
      return {
        name: toMcpName(tool.name),
        description: tool.description,
        inputSchema: {
          type: 'object' as const,
          properties: {
            projectRoot: {
              type: 'string',
              description:
                'Absolute path of the project to analyze — ' +
                router.packForTool(tool.name).projectRootHint,
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
      const toolName = byMcpName.get(request.params.name);
      if (toolName === undefined) {
        throw new Error(`Unknown tool "${request.params.name}"`);
      }
      const result = await router.call(toolName, projectRoot, input);
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

  return { server, router };
}

const toMcpName = (name: string) => name.replaceAll('/', '_');

/**
 * MCP name back to registry name, by lookup rather than by reversing
 * the substitution. Reversing is only sound while no registered name
 * contains an underscore, which is true — the registry's name pattern
 * forbids it — but true by a rule enforced somewhere else entirely.
 */
function mcpNames(names: readonly string[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const name of names) {
    const mcp = toMcpName(name);
    const clash = map.get(mcp);
    if (clash !== undefined) {
      throw new Error(`Tools "${clash}" and "${name}" both map to the MCP name "${mcp}"`);
    }
    map.set(mcp, name);
  }
  return map;
}
