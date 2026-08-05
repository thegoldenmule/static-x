import ts from 'typescript';
import type { Finding, Tool } from '../../../core/tool/index.js';
import type { TsProjectSession } from '../../project/index.js';

export interface LongCommentsInput {
  /** Flag blocks spanning more than this many lines. Default 10. */
  maxLines?: number;
  /** Flag blocks longer than this many characters. Default 800. */
  maxChars?: number;
}

const DEFAULT_MAX_LINES = 10;
const DEFAULT_MAX_CHARS = 800;

/** Comments that configure tools rather than document code. */
const DIRECTIVE = /^\/\/(?:\/\s*<reference\b|\s*(?:@ts-\w|eslint-|tslint:|prettier-ignore))/;
const LICENSE = /\b(?:copyright|licen[cs]e|spdx)\b|\(c\)/i;

interface CommentBlock {
  pos: number;
  end: number;
  startLine: number;
  endLine: number;
  kind: 'line-block' | 'block';
}

/**
 * All comment ranges in a file, parser-aware: collected from node
 * trivia rather than text scanning, so slashes inside strings,
 * templates, and regexes can't produce false comments.
 */
function collectCommentRanges(sourceFile: ts.SourceFile): ts.CommentRange[] {
  const text = sourceFile.getFullText();
  const seen = new Set<number>();
  const ranges: ts.CommentRange[] = [];
  const add = (found: ts.CommentRange[] | undefined) => {
    for (const range of found ?? []) {
      if (!seen.has(range.pos)) {
        seen.add(range.pos);
        ranges.push(range);
      }
    }
  };
  const visit = (node: ts.Node) => {
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(text, node.getEnd()));
    node.forEachChild(visit);
  };
  visit(sourceFile);
  add(ts.getLeadingCommentRanges(text, sourceFile.endOfFileToken.getFullStart()));
  return ranges.sort((a, b) => a.pos - b.pos);
}

/**
 * Group consecutive whole-line `//` comments into blocks; block
 * comments stand alone. Directive comments are dropped and split
 * whatever block they appear in.
 */
function toBlocks(sourceFile: ts.SourceFile, ranges: ts.CommentRange[]): CommentBlock[] {
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

export function findLongCommentsInFile(
  sourceFile: ts.SourceFile,
  input: LongCommentsInput = {},
): Finding[] {
  const maxLines = input.maxLines ?? DEFAULT_MAX_LINES;
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const text = sourceFile.getFullText();
  const firstToken = sourceFile.getStart();
  const findings: Finding[] = [];

  for (const block of toBlocks(sourceFile, collectCommentRanges(sourceFile))) {
    const lines = block.endLine - block.startLine + 1;
    const chars = block.end - block.pos;
    if (lines <= maxLines && chars <= maxChars) continue;
    // License/copyright headers are conventionally long; skip them.
    if (block.end <= firstToken && LICENSE.test(text.slice(block.pos, block.end))) continue;

    const reason =
      lines > maxLines
        ? `spans ${lines} lines (limit ${maxLines})`
        : `is ${chars} characters (limit ${maxChars})`;
    findings.push({
      file: sourceFile.fileName,
      range: {
        start: { line: block.startLine, character: 0 },
        end: sourceFile.getLineAndCharacterOfPosition(block.end),
      },
      code: 'comment.long',
      message: `Comment block ${reason}. Long comments often restate code or hide stale context; consider tightening or deleting.`,
      severity: 'info',
      data: { lines, chars, maxLines, maxChars, kind: block.kind },
    });
  }
  return findings;
}

export const longComments: Tool<LongCommentsInput, Finding[], TsProjectSession> = {
  name: 'ts/comments/long',
  description:
    'Finds comment blocks that exceed line/character thresholds, using the parsed AST ' +
    '(never matches comment-like text inside strings). Skips license headers and ' +
    'directive comments. Each finding is a candidate for tightening or deletion.',
  inputSchema: {
    type: 'object',
    properties: {
      maxLines: { type: 'integer', minimum: 1, description: 'Line-count threshold (default 10)' },
      maxChars: { type: 'integer', minimum: 1, description: 'Character threshold (default 800)' },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'array',
    items: { $ref: '#/definitions/finding' },
  },
  run(session, input) {
    return Promise.resolve(
      session.sourceFiles().flatMap((sourceFile) => findLongCommentsInFile(sourceFile, input)),
    );
  },
};
