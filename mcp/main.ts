import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTsRegistry } from '../ts/registry.js';
import { createMcpServer } from './server.js';

const { server, ferry } = createMcpServer(createTsRegistry());

process.on('SIGINT', () => {
  void ferry.dispose().finally(() => process.exit(0));
});

await server.connect(new StdioServerTransport());
