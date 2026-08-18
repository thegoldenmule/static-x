import { readFile } from 'node:fs/promises';
import { lineStartsOf } from '../../core/text/index.js';
import type { CommentFile, CommentRange } from '../../core/comments/index.js';
import type { SwiftProjectSession } from '../project/index.js';

interface Token {
  start: number;
  end: number;
  type: string;
  doc: boolean;
}

/**
 * Decode the LSP 5-tuple delta encoding into absolute offsets.
 * Positions are UTF-16 code units, which is what a JS string index
 * already is, so no conversion is needed.
 */
function decodeTokens(
  data: readonly number[],
  lineStarts: readonly number[],
  legend: { tokenTypes: string[]; tokenModifiers: string[] },
): Token[] {
  const docBit = legend.tokenModifiers.indexOf('documentation');
  const tokens: Token[] = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i]!;
    const deltaChar = data[i + 1]!;
    const length = data[i + 2]!;
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaChar : deltaChar;
    const lineStart = lineStarts[line];
    if (lineStart === undefined) continue;
    const start = lineStart + character;
    tokens.push({
      start,
      end: start + length,
      type: legend.tokenTypes[data[i + 3]!] ?? '',
      doc: docBit >= 0 && (data[i + 4]! & (1 << docBit)) !== 0,
    });
  }
  return tokens;
}

/**
 * Join the per-line pieces of a block comment back into one range.
 *
 * sourcekit-lsp emits one `comment` token per line, so a ten-line `/**`
 * block arrives as ten tokens. Left alone, every multi-line block
 * comment would read as a run of one-line comments and `comments/long`
 * could never report one — the tool would look like it worked and would
 * simply never fire on the shape it most exists for.
 *
 * A `//` comment is genuinely one range per line and is left alone;
 * core/comments does its own grouping over those, with rules this layer
 * has no business duplicating. Depth counting rather than "ends with
 * the close marker", because Swift block comments nest.
 */
function joinBlocks(tokens: readonly Token[], text: string): CommentRange[] {
  const ranges: CommentRange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const body = text.slice(token.start, token.end);
    if (!body.startsWith('/*')) {
      ranges.push({ pos: token.start, end: token.end, line: true, doc: token.doc });
      continue;
    }
    let depth = 0;
    let end = token.start;
    let doc = token.doc;
    for (let j = i; j < tokens.length; j++) {
      const piece = tokens[j]!;
      const pieceText = text.slice(piece.start, piece.end);
      depth += (pieceText.match(/\/\*/g) ?? []).length;
      depth -= (pieceText.match(/\*\//g) ?? []).length;
      end = piece.end;
      doc ||= piece.doc;
      i = j;
      if (depth <= 0) break;
    }
    ranges.push({ pos: token.start, end, line: false, doc });
  }
  return ranges;
}

/**
 * One file as the language-neutral comment rules see it, sourced from
 * the compiler's own classification rather than a lexer of ours: a `//`
 * inside a string literal is a `string` token here and can never be
 * mistaken for a comment.
 */
export async function commentFileFor(
  session: SwiftProjectSession,
  file: string,
): Promise<CommentFile> {
  const { client, legend } = await session.server();
  const text = await readFile(file, 'utf8');
  const lineStarts = lineStartsOf(text);
  const uri = await client.openDocument(file, 'swift');
  const result = await client.request<{ data?: number[] } | null>(
    'textDocument/semanticTokens/full',
    { textDocument: { uri } },
  );

  const tokens = decodeTokens(result?.data ?? [], lineStarts, legend);
  const comments = tokens.filter((token) => token.type === 'comment');
  // The first token that is not a comment: the analogue of TypeScript's
  // sourceFile.getStart(), and what makes a license header identifiable
  // as one sitting above all the code rather than merely early in the
  // file.
  const firstCode = tokens.find((token) => token.type !== 'comment');

  return {
    file,
    text,
    lineStarts,
    ranges: joinBlocks(comments, text),
    firstCodeOffset: firstCode?.start ?? text.length,
  };
}
