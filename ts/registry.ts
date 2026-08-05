import { ToolRegistry } from '../core/tool/index.js';
import { longComments } from './comments/long/long.js';

/** Every shipped TypeScript tool, registered. */
export function createTsRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(longComments);
  return registry;
}
