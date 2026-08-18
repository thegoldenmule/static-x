import { ToolRegistry } from '../core/tool/index.js';

/**
 * Every shipped Swift tool, registered in the alphabetical order the
 * CLI and MCP listings display (the registry sorts regardless).
 */
export function createSwiftRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  return registry;
}
