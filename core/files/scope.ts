import { statSync } from 'node:fs';
import path from 'node:path';
import type { Finding, Tool } from '../tool/index.js';

/**
 * A set of paths naming the files a tool should report findings in —
 * the changed-files list a git hook or a Claude Code tool hook has on
 * hand. Scoping is a reporting filter, not an analysis filter: tools
 * still see the whole project (import graphs, symbol indexes, and
 * duplicate groups are only correct project-wide), they just narrow
 * what they report.
 *
 * Entries may be absolute, relative to the project root, or relative to
 * the process's working directory — a hook run from a repo root against
 * a project in a subdirectory produces the last kind. All readings are
 * kept as candidates; the ones naming no real project file simply match
 * nothing, so callers can pass a raw `git diff --name-only` list
 * (deleted files, markdown, lockfiles) without pre-filtering.
 *
 * A directory entry matches everything beneath it.
 */

function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

export class FileScope {
  /** Every candidate reading of every entry, absolute. */
  readonly #entries: readonly string[];
  /** Entries that could be directories, as `dir + sep` prefixes. */
  readonly #prefixes: readonly string[];
  readonly #sourceExtensions: ReadonlySet<string>;
  #selectsNothing: boolean | undefined;

  private constructor(entries: readonly string[], sourceExtensions: ReadonlySet<string>) {
    this.#entries = entries;
    this.#sourceExtensions = sourceExtensions;
    this.#prefixes = entries
      .filter((entry) => !sourceExtensions.has(path.extname(entry).toLowerCase()))
      .map((entry) => entry + path.sep);
  }

  /**
   * Resolves `paths` against every base (project root, working
   * directory), keeping each reading as a candidate.
   *
   * `sourceExtensions` is required rather than defaulted, and comes
   * from the pack whose tools this scope will narrow. A default would
   * let a new pack silently inherit another language's answer, which
   * is the bug this parameter exists to remove.
   */
  static from(
    paths: readonly string[],
    bases: readonly string[],
    sourceExtensions: ReadonlySet<string>,
  ): FileScope {
    const entries = new Set<string>();
    for (const raw of paths) {
      const trimmed = raw.trim();
      if (trimmed === '') continue;
      if (path.isAbsolute(trimmed)) {
        entries.add(path.resolve(trimmed));
        continue;
      }
      for (const base of bases) entries.add(path.resolve(base, trimmed));
    }
    return new FileScope([...entries], sourceExtensions);
  }

  /** Does this scope name `file`, directly or through a directory? */
  has(file: string): boolean {
    const target = path.resolve(file);
    return (
      this.#entries.includes(target) ||
      this.#prefixes.some((prefix) => target.startsWith(prefix))
    );
  }

  /**
   * True when no entry could name a file *this pack* analyzes — an
   * empty list, a docs-only commit, or a commit touching only another
   * language. Dispatch answers with no findings then, so the pack never
   * pays for loading a project it has nothing to say about. Entries
   * that are real directories count as selecting, whatever their name.
   */
  selectsNothing(): boolean {
    this.#selectsNothing ??= this.#entries.every(
      (entry) =>
        !this.#sourceExtensions.has(path.extname(entry).toLowerCase()) && !isDirectory(entry),
    );
    return this.#selectsNothing;
  }
}

/**
 * Is this finding about a file in scope? A finding is in scope when its
 * own file is, or when it spans several files (`data.files`, the
 * convention for group findings like import cycles, holding
 * project-relative paths) and any of them is. Without the span check, a
 * cycle anchored on an untouched file would go unreported by the very
 * hook meant to catch it.
 */
export function findingInScope(finding: Finding, scope: FileScope, rootPath: string): boolean {
  if (scope.has(finding.file)) return true;
  const spans = finding.data?.files;
  return (
    Array.isArray(spans) &&
    spans.some((file) => typeof file === 'string' && scope.has(path.resolve(rootPath, file)))
  );
}

export function scopeFindings(
  findings: readonly Finding[],
  scope: FileScope,
  rootPath: string,
): Finding[] {
  return findings.filter((finding) => findingInScope(finding, scope, rootPath));
}

/**
 * Whether a tool can be scoped to a file list. Analysis tools return
 * `Finding[]` and can; refactors return an edit object, where a partial
 * file list would silently mean a partial refactor, and cannot.
 */
export function supportsFileScope(tool: Tool): boolean {
  return (tool.outputSchema as { type?: unknown }).type === 'array';
}

/** JSON Schema for the reserved `files` key, advertised by adapters. */
export const FILES_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Report findings only in these files — paths relative to the project root or absolute, ' +
    'directories included; the whole project is still analyzed. Intended for hooks passing a ' +
    'changed-files list. Omit to report on the whole project.',
};
