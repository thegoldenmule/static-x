import path from 'node:path';
import {
  filterFindings,
  isFindingArray,
  loadProjectConfig,
  toolConfigFor,
  type ProjectConfig,
} from '../../core/config/index.js';
import { ToolRegistry } from '../../core/tool/index.js';
import { TsProjectSession } from '../project/index.js';

/**
 * Dispatch layer between tool consumers (CLI, MCP) and tools. Owns a
 * session cache keyed by project root so repeated calls against the
 * same project reuse the language server and typechecked program.
 * Applies the project's static-x.json: default input under explicit
 * input, then ignore/severity/confidence filters on finding output.
 */
export class TsFerry {
  readonly registry: ToolRegistry;
  #sessions = new Map<string, TsProjectSession>();
  #configs = new Map<string, ProjectConfig | undefined>();

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

  async #configFor(rootPath: string): Promise<ProjectConfig | undefined> {
    if (!this.#configs.has(rootPath)) {
      this.#configs.set(rootPath, await loadProjectConfig(rootPath));
    }
    return this.#configs.get(rootPath);
  }

  async call(toolName: string, projectRoot: string, input: unknown): Promise<unknown> {
    const tool = this.registry.get(toolName);
    const session = this.session(projectRoot);
    const config = toolConfigFor(await this.#configFor(session.rootPath), toolName);

    let effectiveInput = input;
    if (config?.input) {
      const explicit =
        input !== null && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      effectiveInput = { ...config.input, ...explicit };
    }

    const result = await tool.run(session, effectiveInput);
    return config && isFindingArray(result) ? filterFindings(result, config) : result;
  }

  async dispose(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.dispose()));
  }
}
