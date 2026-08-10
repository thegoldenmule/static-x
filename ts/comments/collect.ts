import ts from 'typescript';

/**
 * All comment ranges in a file, parser-aware: collected from node
 * trivia rather than text scanning, so slashes inside strings,
 * templates, and regexes can't produce false comments. JSX children
 * need the same guard from the other direction: `//` inside JsxText is
 * renderable text, but the lexical trivia scanners don't know that and
 * fabricate comment ranges when asked to scan at JSX-text boundaries,
 * so any range starting inside a JsxText span is dropped.
 */
export function collectCommentRanges(sourceFile: ts.SourceFile): ts.CommentRange[] {
  const text = sourceFile.getFullText();
  const seen = new Set<number>();
  const ranges: ts.CommentRange[] = [];
  const jsxTextSpans: ts.TextRange[] = [];
  const add = (found: ts.CommentRange[] | undefined) => {
    for (const range of found ?? []) {
      if (!seen.has(range.pos)) {
        seen.add(range.pos);
        ranges.push(range);
      }
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      jsxTextSpans.push({ pos: node.pos, end: node.end });
      return;
    }
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(text, node.getEnd()));
    node.forEachChild(visit);
  };
  visit(sourceFile);
  add(ts.getLeadingCommentRanges(text, sourceFile.endOfFileToken.getFullStart()));
  return ranges
    .filter((range) => !jsxTextSpans.some((span) => range.pos >= span.pos && range.pos < span.end))
    .sort((a, b) => a.pos - b.pos);
}

export interface CommentBlock {
  pos: number;
  end: number;
  startLine: number;
  endLine: number;
  /** line-block: one or more whole-line // comments; block: /* or trailing. */
  kind: 'line-block' | 'block';
}

/** Comments that configure tools rather than document code. */
export const DIRECTIVE =
  /^\/\/(?:\/\s*<reference\b|\s*(?:@ts-\w|eslint-|tslint:|prettier-ignore))/;

/**
 * Group consecutive whole-line `//` comments into blocks; block
 * comments stand alone. Directive comments are dropped and split
 * whatever block they appear in.
 */
export function toBlocks(sourceFile: ts.SourceFile, ranges: ts.CommentRange[]): CommentBlock[] {
  const text = sourceFile.getFullText();
  const blocks: CommentBlock[] = [];
  let current: CommentBlock | undefined;

  for (const range of ranges) {
    const startLine = sourceFile.getLineAndCharacterOfPosition(range.pos).line;
    const endLine = sourceFile.getLineAndCharacterOfPosition(range.end).line;
    const commentText = text.slice(range.pos, range.end);

    if (DIRECTIVE.test(commentText)) {
      current = undefined;
      continue;
    }
    const lineStart = sourceFile.getPositionOfLineAndCharacter(startLine, 0);
    const wholeLine =
      range.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
      text.slice(lineStart, range.pos).trim() === '';

    if (wholeLine && current?.kind === 'line-block' && current.endLine === startLine - 1) {
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
    };
    blocks.push(current);
    // Trailing comments (code before them on the line) never merge.
    if (range.kind === ts.SyntaxKind.SingleLineCommentTrivia && !wholeLine) {
      current = undefined;
    }
  }
  return blocks;
}
