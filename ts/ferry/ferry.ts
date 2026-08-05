import path from 'node:path';
import { ToolRegistry } from '../../core/tool/index.js';
import { TsProjectSession } from '../project/index.js';

/**
 * Dispatch layer between tool consumers (CLI, MCP) and tools. Owns a
 * session cache keyed by project root so repeated calls against the
 * same project reuse the language server and typechecked program.
 */
export class TsFerry {
  readonly registry: ToolRegistry;
  #sessions = new Map<string, TsProjectSession>();

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  session(projectRoot: string): TsProjectSession {
    const key = path.resolve(projectRoot);
    let session = this.#sessions.get(key);
    if (!session) {
      session = TsProjectSession.open(key);
      this.#sessions.set(key, session);
    }
    return session;
  }

  async call(toolName: string, projectRoot: string, input: unknown): Promise<unknown> {
    const tool = this.registry.get(toolName);
    return tool.run(this.session(projectRoot), input);
  }

  async dispose(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.dispose()));
  }
}
