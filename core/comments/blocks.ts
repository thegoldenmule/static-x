import { positionAt } from '../text/index.js';
import type { CommentBlock, CommentFile } from './types.js';

/**
 * Group consecutive whole-line `//` comments into blocks; block
 * comments stand alone. A directive is dropped and splits its block:
 * it is tooling, not prose, and the rules downstream only read prose.
 * A doc run never merges with a non-doc run — a no-op in TypeScript,
 * but in Swift `///` and `//` are both line comments and that flag is
 * all that separates a DocC summary from a note to self.
 */
export function toBlocks(file: CommentFile, directive: RegExp): CommentBlock[] {
  const { text, lineStarts } = file;
  const blocks: CommentBlock[] = [];
  let current: CommentBlock | undefined;

  for (const range of file.ranges) {
    const startLine = positionAt(lineStarts, range.pos).line;
    const endLine = positionAt(lineStarts, range.end).line;
    const commentText = text.slice(range.pos, range.end);

    if (directive.test(commentText)) {
      current = undefined;
      continue;
    }
    const wholeLine = range.line && text.slice(lineStarts[startLine], range.pos).trim() === '';

    if (
      wholeLine &&
      current?.kind === 'line-block' &&
      current.endLine === startLine - 1 &&
      current.doc === range.doc
    ) {
      current.end = range.end;
      current.endLine = endLine;
      continue;
    }
    current = {
      pos: range.pos,
      end: range.end,
      startLine,
      endLine,
      kind: wholeLine ? 'line-block' : 'block',
      doc: range.doc,
    };
    blocks.push(current);
    // Trailing comments (code before them on the line) never merge.
    if (range.line && !wholeLine) current = undefined;
  }
  return blocks;
}
