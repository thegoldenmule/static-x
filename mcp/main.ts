import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PackRouter } from '../core/pack/index.js';
import { createPacks } from '../packs/index.js';
import { createMcpServer } from './server.js';

const { server, router } = createMcpServer(new PackRouter(createPacks()));

process.on('SIGINT', () => {
  void router.dispose().finally(() => process.exit(0));
});

await server.connect(new StdioServerTransport());
