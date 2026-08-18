import type { Finding, Tool } from '../../../core/tool/index.js';
import { FINDINGS_ARRAY_SCHEMA } from '../../../core/tool/index.js';
import { findLongComments, toBlocks } from '../../../core/comments/index.js';
import type { SwiftProjectSession } from '../../project/index.js';
import { commentFileFor } from '../ranges.js';
import { SWIFT_DIRECTIVE, SWIFT_LICENSE } from '../conventions.js';

export interface LongCommentsInput {
  /** Flag blocks spanning more than this many lines. Default 10. */
  maxLines?: number;
  /** Flag blocks longer than this many characters. Default 800. */
  maxChars?: number;
}

export async function findLongCommentsInFile(
  session: SwiftProjectSession,
  file: string,
  input: LongCommentsInput = {},
): Promise<Finding[]> {
  const commentFile = await commentFileFor(session, file);
  return findLongComments(commentFile, toBlocks(commentFile, SWIFT_DIRECTIVE), {
    ...input,
    license: SWIFT_LICENSE,
  });
}

export const swiftLongComments: Tool<LongCommentsInput, Finding[], SwiftProjectSession> = {
  name: 'swift/comments/long',
  description:
    'Finds comment blocks that exceed line/character thresholds, using sourcekit-lsp semantic ' +
    'tokens (never matches comment-like text inside strings, raw strings, or interpolation). ' +
    'Skips license headers and directive comments, including // MARK:.',
  inputSchema: {
    type: 'object',
    properties: {
      maxLines: { type: 'integer', minimum: 1, description: 'Line-count threshold (default 10)' },
      maxChars: { type: 'integer', minimum: 1, description: 'Character threshold (default 800)' },
    },
    additionalProperties: false,
  },
  outputSchema: FINDINGS_ARRAY_SCHEMA,
  async run(session, input) {
    const findings: Finding[] = [];
    for (const file of session.targetFiles()) {
      findings.push(...(await findLongCommentsInFile(session, file, input)));
    }
    return findings;
  },
};
