import type { Tool } from './types.js';

/** Tool names are path-like and lowercase: "ts/comments/long". */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

export class ToolRegistry {
  #tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (!NAME_PATTERN.test(tool.name)) {
      throw new Error(
        `Invalid tool name "${tool.name}": expected path-like lowercase segments, e.g. "ts/comments/long"`,
      );
    }
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.#tools.set(tool.name, tool);
  }

  get(name: string): Tool {
    const tool = this.#tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool "${name}". Registered: ${this.names().join(', ') || '(none)'}`);
    }
    return tool;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  names(): string[] {
    return [...this.#tools.keys()].sort();
  }

  list(): Tool[] {
    return this.names().map((name) => this.#tools.get(name)!);
  }
}
