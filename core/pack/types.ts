import type { CheckSuite } from '../checks/index.js';
import type { ToolRegistry } from '../tool/index.js';

/**
 * What the router needs of a dispatch layer. Declared structurally
 * rather than imported from core/checks, so this module depends on one
 * thing there — and PackRouter still satisfies that module's Dispatcher
 * for free.
 */
export interface PackFerry {
  call(toolName: string, projectRoot: string, input: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

/**
 * One language's tools plus the machinery to reach them. Core learns
 * that packs exist; it never learns which ones. Everything specific to
 * a language lives behind these members.
 */
export interface LanguagePack {
  /** First path segment of every tool this pack registers. */
  readonly id: string;
  /** For listings and errors: "TypeScript". */
  readonly label: string;
  /** Extensions this pack can hold source files for. */
  readonly sourceExtensions: ReadonlySet<string>;
  /** How an adapter describes projectRoot for this pack's tools. */
  readonly projectRootHint: string;
  readonly defaultChecks: Readonly<Record<string, CheckSuite>>;
  readonly fixableCodes: ReadonlySet<string>;
  /**
   * Would a session open here? Filesystem only — no subprocess, no
   * session. Must call the same discovery the pack's session does, or
   * the two can disagree and a tool gets offered that then fails.
   */
  binds(rootPath: string): boolean;
  createRegistry(): ToolRegistry;
  createFerry(registry: ToolRegistry): PackFerry;
}
