import { readFile, stat } from 'node:fs/promises';
import { lineStartsOf } from '../../core/text/index.js';
import type { SwiftProjectSession } from '../project/index.js';

export interface SwiftToken {
  start: number;
  end: number;
  type: string;
  doc: boolean;
  declaration: boolean;
}

interface SwiftTokens {
  file: string;
  text: string;
  lineStarts: readonly number[];
  tokens: readonly SwiftToken[];
}

/**
 * One semantic-token request per file, cached on the session by
 * modification time and size.
 *
 * The cache is not only a speed measure. The comment family and the
 * stale-refs name index both need every token in every source file, and
 * without sharing, a stale-refs run would ask the server for the same
 * file twice — which on an Xcode project, where a single file can cost
 * seconds, is the difference between a tool that is slow and one nobody
 * will wait for.
 */
const CACHES = new WeakMap<SwiftProjectSession, Map<string, { key: string; value: SwiftTokens }>>();

export async function semanticTokensFor(
  session: SwiftProjectSession,
  file: string,
): Promise<SwiftTokens> {
  let cache = CACHES.get(session);
  if (!cache) {
    cache = new Map();
    CACHES.set(session, cache);
  }
  const info = await stat(file);
  const key = `${String(info.mtimeMs)}:${String(info.size)}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.value;

  const { client, legend } = await session.server();
  const text = await readFile(file, 'utf8');
  const lineStarts = lineStartsOf(text);
  const uri = await client.openDocument(file, 'swift');
  const result = await client.request<{ data?: number[] } | null>(
    'textDocument/semanticTokens/full',
    { textDocument: { uri } },
  );

  const docBit = legend.tokenModifiers.indexOf('documentation');
  const declBit = legend.tokenModifiers.indexOf('declaration');
  const data = result?.data ?? [];
  const tokens: SwiftToken[] = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i]!;
    const deltaChar = data[i + 1]!;
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaChar : deltaChar;
    const lineStart = lineStarts[line];
    if (lineStart === undefined) continue;
    const start = lineStart + character;
    const modifiers = data[i + 4]!;
    tokens.push({
      start,
      end: start + data[i + 2]!,
      type: legend.tokenTypes[data[i + 3]!] ?? '',
      doc: docBit >= 0 && (modifiers & (1 << docBit)) !== 0,
      declaration: declBit >= 0 && (modifiers & (1 << declBit)) !== 0,
    });
  }

  const value: SwiftTokens = { file, text, lineStarts, tokens };
  cache.set(file, { key, value });
  return value;
}
