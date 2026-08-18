import ts from 'typescript';
import type { Finding, Tool } from '../../../core/tool/index.js';
import { FINDINGS_ARRAY_SCHEMA } from '../../../core/tool/index.js';
import { findLongComments, toBlocks } from '../../../core/comments/index.js';
import type { TsProjectSession } from '../../project/index.js';
import { DIRECTIVE, toCommentFile } from '../collect.js';

export interface LongCommentsInput {
  /** Flag blocks spanning more than this many lines. Default 10. */
  maxLines?: number;
  /** Flag blocks longer than this many characters. Default 800. */
  maxChars?: number;
}

const LICENSE = /\b(?:copyright|licen[cs]e|spdx)\b|\(c\)/i;

export function findLongCommentsInFile(
  sourceFile: ts.SourceFile,
  input: LongCommentsInput = {},
): Finding[] {
  const file = toCommentFile(sourceFile);
  return findLongComments(file, toBlocks(file, DIRECTIVE), { ...input, license: LICENSE });
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
