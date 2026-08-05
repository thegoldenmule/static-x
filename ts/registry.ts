import { ToolRegistry } from '../core/tool/index.js';
import { llmTells } from './comments/llm-tells/llm-tells.js';
import { longComments } from './comments/long/long.js';
import { staleRefs } from './comments/stale-refs/stale-refs.js';
import { rename } from './refactors/rename/rename.js';

/** Every shipped TypeScript tool, registered. */
export function createTsRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(longComments);
  registry.register(staleRefs);
  registry.register(llmTells);
  registry.register(rename);
  return registry;
}
