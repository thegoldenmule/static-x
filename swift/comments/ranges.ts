import type { CommentFile, CommentRange } from '../../core/comments/index.js';
import type { SwiftProjectSession } from '../project/index.js';
import { semanticTokensFor, type SwiftToken } from './tokens.js';

/**
 * Join the per-line pieces of a block comment back into one range.
 *
 * sourcekit-lsp emits one `comment` token per line, so a ten-line block
 * arrives as ten tokens. Left alone, every multi-line block comment
 * would read as a run of one-line comments and comments/long could
 * never report one — the tool would look like it worked and simply
 * never fire on the shape it most exists for.
 *
 * A `//` comment is genuinely one range per line and is left alone;
 * core/comments groups those with rules this layer has no business
 * duplicating. Depth counting rather than "ends with the close
 * marker", because Swift block comments nest.
 */
function joinBlocks(tokens: readonly SwiftToken[], text: string): CommentRange[] {
  const ranges: CommentRange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!text.slice(token.start, token.end).startsWith('/*')) {
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
  const { text, lineStarts, tokens } = await semanticTokensFor(session, file);
  const comments = tokens.filter((token) => token.type === 'comment');
  // The first token that is not a comment: the analogue of TypeScript's
  // sourceFile.getStart(), and what makes a license header identifiable
  // as one sitting above all the code rather than merely early in it.
  const firstCode = tokens.find((token) => token.type !== 'comment');

  return {
    file,
    text,
    lineStarts,
    ranges: joinBlocks(comments, text),
    firstCodeOffset: firstCode?.start ?? text.length,
  };
}
