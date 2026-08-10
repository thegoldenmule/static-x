import ts from 'typescript';
import type { Finding, Tool } from '../../../core/tool/index.js';
import { FINDINGS_ARRAY_SCHEMA } from '../../../core/tool/index.js';
import { truncateFlat } from '../../ast/truncate.js';
import type { TsProjectSession } from '../../project/index.js';
import { collectCommentRanges, toBlocks } from '../collect.js';

export interface LongCommentsInput {
  /** Flag blocks spanning more than this many lines. Default 10. */
  maxLines?: number;
  /** Flag blocks longer than this many characters. Default 800. */
  maxChars?: number;
}

const DEFAULT_MAX_LINES = 10;
const DEFAULT_MAX_CHARS = 800;
/** data.name is the flattened comment head, the static-x.json ignore key. */
const MAX_NAME_CHARS = 60;

const LICENSE = /\b(?:copyright|licen[cs]e|spdx)\b|\(c\)/i;

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
      data: {
        name: truncateFlat(text.slice(block.pos, block.end), MAX_NAME_CHARS),
        lines,
        chars,
        maxLines,
        maxChars,
        kind: block.kind,
      },
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
  outputSchema: FINDINGS_ARRAY_SCHEMA,
  run(session, input) {
    return Promise.resolve(
      session.targetFiles().flatMap((sourceFile) => findLongCommentsInFile(sourceFile, input)),
    );
  },
};
