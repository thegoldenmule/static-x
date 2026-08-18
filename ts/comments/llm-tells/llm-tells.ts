import ts from 'typescript';
import type { Finding, Tool } from '../../../core/tool/index.js';
import { FINDINGS_ARRAY_SCHEMA } from '../../../core/tool/index.js';
import { findLlmTells, toBlocks } from '../../../core/comments/index.js';
import type { TsProjectSession } from '../../project/index.js';
import { DIRECTIVE, toCommentFile } from '../collect.js';

export interface LlmTellsInput {
  /** Minimum summed pattern weight to flag a comment. Default 1. */
  minScore?: number;
}

/** Strip comment markers, leaving the prose. */
function contentOf(raw: string): string {
  return raw
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\/\/|\*)?\s?/, ''))
    .join('\n')
    .trim();
}

export function findLlmTellsInFile(
  sourceFile: ts.SourceFile,
  input: LlmTellsInput = {},
): Finding[] {
  const file = toCommentFile(sourceFile);
  return findLlmTells(file, toBlocks(file, DIRECTIVE), {
    ...input,
    contentOf,
    narratable: (block) => block.kind === 'line-block',
  });
}

export const llmTells: Tool<LlmTellsInput, Finding[], TsProjectSession> = {
  name: 'ts/comments/llm-tells',
  description:
    'Finds comments with LLM-generated hallmarks: filler phrasing ("it\'s worth noting", ' +
    '"seamlessly", "delve"), change-log prose describing the edit instead of the code, ' +
    'and narration comments that restate the line below them. Patterns and weights live ' +
    'in core/comments/tells/patterns.ts; findings report the matched pattern ids and summed score.',
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
  run(session, input) {
    return Promise.resolve(
      session.targetFiles().flatMap((sourceFile) => findLlmTellsInFile(sourceFile, input)),
    );
  },
};
