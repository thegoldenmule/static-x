import path from 'node:path';
import {
  filterFindings,
  isFindingArray,
  loadProjectConfig,
  toolConfigFor,
  type ProjectConfig,
} from '../config/index.js';
import { FileScope, scopeFindings, supportsFileScope } from '../files/index.js';
import { ToolRegistry, type ProjectSession, type Tool } from '../tool/index.js';

/**
 * Dispatch between tool consumers (CLI, MCP) and tools. Caches one
 * session per project root, serializes calls against it, and applies
 * the project's static-x.json — config input under explicit input,
 * then the finding filters.
 *
 * `files` is reserved here rather than being a per-tool input because
 * every analysis tool accepts it. Tools honor it by iterating
 * targetFiles(); findings are filtered here too, which is what makes
 * whole-project tools (duplicate groups, import cycles) scopeable
 * without each reimplementing the narrowing.
 *
 * Generic over the session so one implementation serves every pack:
 * this is core/config, core/files, and a queue. It lived in ts/ only
 * because there was one pack.
 */

/**
 * What dispatch needs of a session beyond the bare ProjectSession
 * contract. Kept here rather than on ProjectSession so that contract
 * stays the three members a tool consumer actually depends on.
 */
export interface FerrySession extends ProjectSession {
  setScope(scope: FileScope | undefined): void;
}

/** Dispatch-level input keys, stripped before a tool sees its input. */
const RESERVED_INPUT_KEYS = ['files'];

function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** Reads the reserved `files` key, rejecting anything but a string list. */
function readFiles(input: Record<string, unknown>, tool: Tool): string[] | undefined {
  const files = input.files;
  if (files === undefined) return undefined;
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) {
    throw new Error(`files must be an array of paths (got ${JSON.stringify(files)})`);
  }
  if (!supportsFileScope(tool)) {
    throw new Error(
      `Tool "${tool.name}" cannot be scoped to a file list: it rewrites code project-wide, ` +
        'and a partial list would mean a partial refactor. Scoping applies to analysis tools.',
    );
  }
  return files as string[];
}

function withoutReservedKeys(input: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...input };
  for (const key of RESERVED_INPUT_KEYS) delete rest[key];
  return rest;
}

export class Ferry<S extends FerrySession> {
  readonly registry: ToolRegistry;
  #sessions = new Map<string, S>();
  #configs = new Map<string, ProjectConfig | undefined>();
  #queues = new Map<string, Promise<unknown>>();

  readonly #open: (rootPath: string) => S;

  constructor(registry: ToolRegistry, open: (rootPath: string) => S) {
    this.registry = registry;
    this.#open = open;
  }

  session(projectRoot: string): S {
    const key = path.resolve(projectRoot);
    let session = this.#sessions.get(key);
    if (!session) {
      session = this.#open(key);
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

  /**
   * Runs `work` after any call already queued for this project root.
   * One session owns a mutable program, LSP connection, and reporting
   * scope, none of which survive two calls interleaving; different
   * roots still run concurrently.
   */
  async #serialized<T>(projectRoot: string, work: () => Promise<T>): Promise<T> {
    const key = path.resolve(projectRoot);
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    // Swallow rejection on the queue only; callers still see it.
    this.#queues.set(
      key,
      result.catch(() => undefined),
    );
    return result;
  }

  async call(toolName: string, projectRoot: string, input: unknown): Promise<unknown> {
    const tool = this.registry.get(toolName);
    const explicit = asRecord(input);
    const files = readFiles(explicit, tool);

    // A scope naming no source file needs no project: answer before
    // opening a session, so a hook on a docs-only change costs nothing
    // and never fails on a project this pack cannot bind.
    let scope: FileScope | undefined;
    if (files) {
      scope = FileScope.from(files, [path.resolve(projectRoot), process.cwd()]);
      if (scope.selectsNothing()) return [];
    }

    return this.#serialized(projectRoot, async () => {
      const session = this.session(projectRoot);
      const config = toolConfigFor(await this.#configFor(session.rootPath), toolName);
      const effectiveInput = withoutReservedKeys(
        config?.input ? { ...config.input, ...explicit } : explicit,
      );

      session.setScope(scope);
      let result: unknown;
      try {
        result = await tool.run(session, effectiveInput);
      } finally {
        session.setScope(undefined);
      }

      if (!isFindingArray(result)) return result;
      const scoped = scope ? scopeFindings(result, scope, session.rootPath) : result;
      return config ? filterFindings(scoped, config) : scoped;
    });
  }

  async dispose(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#queues.clear();
    await Promise.all(sessions.map((session) => session.dispose()));
  }
}
