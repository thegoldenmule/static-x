import { ToolRegistry } from '../core/tool/index.js';
import { floatingPromises } from './async/floating-promises/floating-promises.js';
import { llmTells } from './comments/llm-tells/llm-tells.js';
import { longComments } from './comments/long/long.js';
import { staleRefs } from './comments/stale-refs/stale-refs.js';
import { dupeFunctions } from './dupes/functions/functions.js';
import { importCycles } from './graph/cycles/cycles.js';
import { deadExports } from './graph/dead-exports/dead-exports.js';
import { rename } from './refactors/rename/rename.js';
import { typeLoopholes } from './types/loopholes/loopholes.js';

/** Every shipped TypeScript tool, registered. */
export function createTsRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(longComments);
  registry.register(staleRefs);
  registry.register(llmTells);
  registry.register(floatingPromises);
  registry.register(dupeFunctions);
  registry.register(importCycles);
  registry.register(deadExports);
  registry.register(typeLoopholes);
  registry.register(rename);
  return registry;
}
