import type { Finding, Tool } from '../../../core/tool/index.js';
import { FINDINGS_ARRAY_SCHEMA } from '../../../core/tool/index.js';
import { findLlmTells, toBlocks } from '../../../core/comments/index.js';
import type { SwiftProjectSession } from '../../project/index.js';
import { commentFileFor } from '../ranges.js';
import { SWIFT_DIRECTIVE, swiftContentOf } from '../conventions.js';

interface LlmTellsInput {
  /** Minimum summed pattern weight to flag a comment. Default 1. */
  minScore?: number;
}

async function findLlmTellsInFile(
  session: SwiftProjectSession,
  file: string,
  input: LlmTellsInput = {},
): Promise<Finding[]> {
  const commentFile = await commentFileFor(session, file);
  return findLlmTells(commentFile, toBlocks(commentFile, SWIFT_DIRECTIVE), {
    ...input,
    contentOf: swiftContentOf,
    // The whole Swift-specific correction, in one predicate. A DocC
    // summary is written directly above the declaration it documents,
    // so it always restates it — that is what a summary is. TypeScript
    // gets this for free because /** */ is a block comment; Swift's ///
    // is a line comment, so without this every correct doc comment in
    // the project reads as narration.
    narratable: (block) => block.kind === 'line-block' && !block.doc,
  });
}

export const swiftLlmTells: Tool<LlmTellsInput, Finding[], SwiftProjectSession> = {
  name: 'swift/comments/llm-tells',
  description:
    'Finds comments with LLM-generated hallmarks: filler phrasing, change-log prose describing ' +
    'the edit instead of the code, and narration comments that restate the line below them. ' +
    'DocC summaries are never narration. Patterns and weights live in ' +
    'core/comments/tells/patterns.ts.',
  inputSchema: {
    type: 'object',
    properties: {
      minScore: {
        type: 'number',
        minimum: 0,
        description: 'Minimum summed pattern weight to flag (default 1)',
      },
    },
    additionalProperties: false,
  },
  outputSchema: FINDINGS_ARRAY_SCHEMA,
  async run(session, input) {
    const findings: Finding[] = [];
    for (const file of session.targetFiles()) {
      findings.push(...(await findLlmTellsInFile(session, file, input)));
    }
    return findings;
  },
};
