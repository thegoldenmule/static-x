import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LspClient } from '../../core/lsp/index.js';
import type { FileScope } from '../../core/files/index.js';
import type { ProjectSession } from '../../core/tool/index.js';
import { startSwiftServer } from '../server/spawn.js';
import { findSwiftProject, type SwiftBinding } from './binding.js';

/**
 * Directory names that are never this project's source. Pods/ and
 * Carthage/ are the direct analogue of gd/'s addons/: vendored
 * third-party code, present in the tree and not the author's to fix.
 */
const NON_SOURCE_DIRS = new Set([
  '.build',
  '.swiftpm',
  'DerivedData',
  'Pods',
  'Carthage',
]);

/** Manifests are .swift files belonging to no target. */
function isManifest(file: string): boolean {
  const base = path.basename(file);
  return base === 'Package.swift' || /^Package@swift-.+\.swift$/.test(base);
}

function walk(root: string, keep: (dir: string) => boolean): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (keep(entry.name)) visit(full);
      } else if (entry.isFile() && entry.name.endsWith('.swift')) {
        found.push(full);
      }
    }
  };
  visit(root);
  return found.sort();
}

/**
 * A bound connection to one Swift project. One view, not three:
 * sourcekit-lsp over stdio. It answers syntactic requests without a
 * build, which is what the shipped tools rely on.
 */
export class SwiftProjectSession implements ProjectSession {
  readonly language = 'swift';
  readonly rootPath: string;
  readonly binding: SwiftBinding;
  #lsp: Promise<LspClient> | undefined;
  #scope: FileScope | undefined;

  private constructor(rootPath: string, binding: SwiftBinding) {
    this.rootPath = rootPath;
    this.binding = binding;
  }

  static open(rootPath: string): SwiftProjectSession {
    const absRoot = path.resolve(rootPath);
    const binding = findSwiftProject(absRoot);
    if (!binding) {
      throw new Error(
        `No Swift project found under ${absRoot} — expected Package.swift, buildServer.json, ` +
          'compile_commands.json, or an .xcodeproj/.xcworkspace at the root.',
      );
    }
    return new SwiftProjectSession(absRoot, binding);
  }

  /**
   * Kept out of the project's own .build so analysing a project never
   * races the developer's editor or leaves artifacts behind. Keyed by
   * root so a warm run reuses whatever the last one cached.
   */
  get scratchPath(): string {
    const key = createHash('sha256').update(this.rootPath).digest('hex').slice(0, 16);
    return path.join(os.tmpdir(), 'static-x-swift', key);
  }

  lsp(): Promise<LspClient> {
    this.#lsp ??= startSwiftServer(this.rootPath, { scratchPath: this.scratchPath });
    return this.#lsp;
  }

  /** Every .swift under the root, vendored directories included. */
  projectFiles(): string[] {
    return walk(this.rootPath, () => true).filter((file) => !isManifest(file));
  }

  /** What analysis reports in. */
  sourceFiles(): string[] {
    return walk(
      this.rootPath,
      (name) => !NON_SOURCE_DIRS.has(name) && !name.startsWith('.'),
    ).filter((file) => !isManifest(file));
  }

  /**
   * An edit's blast radius, deliberately not narrowed. The unit here is
   * the module rather than the directory, and Swift has no per-file
   * import for same-module symbols, so a file's dependents are not
   * discoverable from its own text. Module membership is not exposed by
   * any LSP request; until a tool needs it this is the whole tree.
   */
  compilationFiles(): string[] {
    return this.projectFiles();
  }

  /** sourceFiles() narrowed by the caller's scope: what a tool iterates. */
  targetFiles(): string[] {
    const files = this.sourceFiles();
    const scope = this.#scope;
    return scope ? files.filter((file) => scope.has(file)) : files;
  }

  /** Dispatch-owned: set for one call and cleared after it. */
  setScope(scope: FileScope | undefined): void {
    this.#scope = scope;
  }

  async dispose(): Promise<void> {
    const lsp = this.#lsp;
    this.#lsp = undefined;
    if (lsp) await (await lsp).shutdown();
  }
}
