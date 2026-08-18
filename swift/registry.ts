import { ToolRegistry } from '../core/tool/index.js';
import { swiftLlmTells } from './comments/llm-tells/llm-tells.js';
import { swiftLongComments } from './comments/long/long.js';

/**
 * Every shipped Swift tool, registered in the alphabetical order the
 * CLI and MCP listings display (the registry sorts regardless).
 */
export function createSwiftRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(swiftLlmTells);
  registry.register(swiftLongComments);
  return registry;
}
