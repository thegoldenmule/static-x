import ts from 'typescript';
import type { CommentFile } from '../../core/comments/index.js';

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

/** Comments that configure tools rather than document code. */
export const DIRECTIVE =
  /^\/\/(?:\/\s*<reference\b|\s*(?:@ts-\w|eslint-|tslint:|prettier-ignore))/;

/**
 * One file as the language-neutral comment rules see it. TypeScript's
 * `/**` is the doc form; `//` never is, which is what keeps the
 * doc/non-doc merge rule in core a no-op here.
 */
export function toCommentFile(sourceFile: ts.SourceFile): CommentFile {
  const text = sourceFile.getFullText();
  return {
    file: sourceFile.fileName,
    text,
    lineStarts: sourceFile.getLineStarts(),
    ranges: collectCommentRanges(sourceFile).map((range) => ({
      pos: range.pos,
      end: range.end,
      line: range.kind === ts.SyntaxKind.SingleLineCommentTrivia,
      doc: text.startsWith('/**', range.pos) && !text.startsWith('/**/', range.pos),
    })),
    firstCodeOffset: sourceFile.getStart(),
  };
}
