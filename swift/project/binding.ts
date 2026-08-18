import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

type SwiftProjectKind = 'build-server' | 'swiftpm' | 'compilation-db' | 'xcode';

export interface SwiftBinding {
  kind: SwiftProjectKind;
  /** The file that decided it. */
  configPath: string;
  /**
   * True when sourcekit-lsp has no source of build settings and will
   * guess per file. Syntactic requests are unaffected; anything
   * cross-file is not.
   */
  degraded: boolean;
}

/** Extensions this pack can hold source files for. */
export const SWIFT_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['.swift']);

/**
 * The project a Swift session would bind to, if any. Precedence is
 * confidence order: explicit configuration, then the manifest the
 * server reads unaided, then a compilation database, then Xcode —
 * which without a buildServer.json leaves it guessing per file.
 *
 * Root only, never recursive, and never walking up. War/ has an
 * .xcodeproj at its root and a vendored Package.swift several
 * directories down; a recursive search binds the vendored SDK.
 */
export function findSwiftProject(rootPath: string): SwiftBinding | undefined {
  const root = path.resolve(rootPath);
  const at = (name: string) => path.join(root, name);

  if (existsSync(at('buildServer.json'))) {
    return { kind: 'build-server', configPath: at('buildServer.json'), degraded: false };
  }
  if (existsSync(at('Package.swift'))) {
    return { kind: 'swiftpm', configPath: at('Package.swift'), degraded: false };
  }
  if (existsSync(at('compile_commands.json'))) {
    return { kind: 'compilation-db', configPath: at('compile_commands.json'), degraded: false };
  }

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  // A workspace containing a project is the outer truth, which is the
  // shape CocoaPods produces.
  const workspace = entries.find((entry) => entry.endsWith('.xcworkspace'));
  const project = entries.find((entry) => entry.endsWith('.xcodeproj'));
  const xcode = workspace ?? project;
  if (xcode) return { kind: 'xcode', configPath: at(xcode), degraded: true };

  return undefined;
}

/** Would a Swift session open here? Filesystem only — no server. */
export function bindsSwift(rootPath: string): boolean {
  return findSwiftProject(rootPath) !== undefined;
}
