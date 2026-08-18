import { Ferry, scopeSelectsNothing } from '../../core/ferry/index.js';
import type { PackFerry } from '../../core/pack/index.js';
import type { ToolRegistry } from '../../core/tool/index.js';
import { SwiftProjectSession, SWIFT_SOURCE_EXTENSIONS } from '../project/index.js';
import { callDaemon } from '../daemon/client.js';

/**
 * Dispatch for the Swift pack: the shared ferry, with the daemon in
 * front of it.
 *
 * A daemon failure is never a tool failure. Any error — spawn, connect,
 * protocol, timeout — falls back to the in-process ferry below, which
 * is the same core/ferry the daemon itself hosts, so the answer is
 * identical either way and only the latency differs. A latency
 * optimisation that could break a tool would not be worth having.
 */
export class SwiftFerry implements PackFerry {
  readonly #inProcess: Ferry<SwiftProjectSession>;
  readonly #useDaemon: boolean;

  constructor(registry: ToolRegistry, options: { daemon?: boolean } = {}) {
    this.#inProcess = new Ferry(
      registry,
      (rootPath: string) => SwiftProjectSession.open(rootPath),
      SWIFT_SOURCE_EXTENSIONS,
    );
    // STATIC_X_NO_DAEMON exists for tests and for anyone debugging a
    // result they suspect came from a stale process.
    this.#useDaemon = (options.daemon ?? true) && process.env['STATIC_X_NO_DAEMON'] !== '1';
  }

  async call(toolName: string, projectRoot: string, input: unknown): Promise<unknown> {
    // Before the daemon, not inside it: contacting one starts a
    // language server, and a commit naming no .swift file must not.
    if (scopeSelectsNothing(input, projectRoot, SWIFT_SOURCE_EXTENSIONS)) return [];

    if (this.#useDaemon) {
      try {
        return await callDaemon(projectRoot, toolName, projectRoot, input);
      } catch {
        // Fall through. Deliberately swallowed: the in-process path
        // produces the same answer, and surfacing daemon plumbing as a
        // tool error would make the optimisation a liability.
      }
    }
    return this.#inProcess.call(toolName, projectRoot, input);
  }

  dispose(): Promise<void> {
    return this.#inProcess.dispose();
  }
}
