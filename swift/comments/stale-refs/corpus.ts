import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { SwiftProjectSession } from '../../project/index.js';
import { semanticTokensFor } from '../tokens.js';
import { SWIFT_KEYWORDS } from './keywords.js';

const require = createRequire(import.meta.url);

/** Token types whose text is a name something declared or used. */
const NAME_TOKENS = new Set([
  'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter',
  'parameter', 'variable', 'property', 'enumMember', 'function', 'method', 'macro',
  'identifier',
]);

const IDENTIFIER = /^[A-Za-z_][\w]*$/;
const IMPORT = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*import\s+(?:\w+\s+)?([A-Za-z_][\w.]*)/gm;

/** Directories that are never this project's files. */
const SKIP_DIRS = new Set(['.build', '.swiftpm', 'DerivedData', 'Pods', 'Carthage', '.git', 'node_modules']);

function projectFileNames(root: string): Set<string> {
  const names = new Set<string>();
  const visit = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        names.add(entry.name);
      }
    }
  };
  visit(root, 0);
  return names;
}

function appleNames(): ReadonlySet<string> {
  const data = require('../../data/apple-names.json') as { names: string[] };
  return new Set(data.names);
}

let apple: ReadonlySet<string> | undefined;

interface ResolutionCorpus {
  /** Every name declared or used anywhere in the project. */
  names: ReadonlySet<string>;
  /** Basenames of every source file, for file references. */
  files: ReadonlySet<string>;
  has(name: string): boolean;
}

/**
 * Built once per run, over sourceFiles() rather than targetFiles().
 *
 * A comment in one file names symbols declared in all the others, so a
 * corpus narrowed to the reporting scope would invent stale references
 * — which is the same reason the TypeScript tool indexes the whole
 * project and reports in a subset of it.
 *
 * Names come from the compiler's own token classification rather than a
 * text scan, so a word inside a string literal or a comment is never
 * mistaken for a declaration. String literals are harvested separately
 * and deliberately: union tags, event names and sentinel values are
 * what comments most often name, and they exist even though nothing
 * declares them.
 */
export async function buildCorpus(session: SwiftProjectSession): Promise<ResolutionCorpus> {
  apple ??= appleNames();
  const names = new Set<string>();
  // Every file, not only the analysed .swift ones. A comment naming
  // README.md or Package.swift is naming something real, and an index
  // built from sourceFiles() would report each of them stale — a
  // systematic false positive over an entire reference class.
  const files = projectFileNames(session.rootPath);

  for (const file of session.sourceFiles()) {
    const { text, tokens } = await semanticTokensFor(session, file);
    for (const token of tokens) {
      const body = text.slice(token.start, token.end);
      if (NAME_TOKENS.has(token.type)) {
        if (IDENTIFIER.test(body)) names.add(body);
      } else if (token.type === 'string') {
        // Identifier-ish literal contents: the vocabulary a comment
        // names when it quotes a protocol tag or a stored key.
        for (const piece of body.split(/[^A-Za-z0-9_]+/)) {
          if (piece.length > 2 && IDENTIFIER.test(piece)) names.add(piece);
        }
      }
    }
    // Imported module names are referenced constantly in prose and
    // declared nowhere in the project.
    for (const match of text.matchAll(IMPORT)) {
      for (const piece of (match[1] ?? '').split('.')) names.add(piece);
    }
  }

  const builtin = apple;
  return {
    names,
    files,
    has(name: string): boolean {
      return names.has(name) || SWIFT_KEYWORDS.has(name) || builtin.has(name);
    },
  };
}
