import { ToolRegistry } from '../core/tool/index.js';
import { longComments } from './comments/long/long.js';
import { rename } from './refactors/rename/rename.js';

/** Every shipped TypeScript tool, registered. */
export function createTsRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(longComments);
  registry.register(rename);
  return registry;
}
