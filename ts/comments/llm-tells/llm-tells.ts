import ts from 'typescript';
import type { Finding, Tool } from '../../../core/tool/index.js';
import { FINDINGS_ARRAY_SCHEMA } from '../../../core/tool/index.js';
import { truncateFlat } from '../../../core/text/index.js';
import type { TsProjectSession } from '../../project/index.js';
import { collectCommentRanges, toBlocks, type CommentBlock } from '../collect.js';
import { CHANGELOG, FILLERS, NARRATION_WEIGHT } from './patterns.js';

/** Ignore-filter key length; matches ts/comments/long. */
const MAX_NAME_CHARS = 60;

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

const WORD = /[A-Za-z_$][\w$]*/g;

/**
 * Words of the comment plus concatenations of 2-3 consecutive words,
 * lowercased, so "total count" can match the code token `totalCount`.
 */
function commentNgrams(text: string): Set<string> {
  const words = [...text.matchAll(WORD)].map((match) => match[0].toLowerCase());
  const ngrams = new Set(words);
  for (let i = 0; i < words.length - 1; i++) {
    ngrams.add(words[i]! + words[i + 1]!);
    if (i < words.length - 2) ngrams.add(words[i]! + words[i + 1]! + words[i + 2]!);
  }
  return ngrams;
}

/**
 * Does the comment just restate the statement below it? Compare token
 * overlap: if most of the code line's tokens already appear in the
 * comment, the comment adds nothing the code doesn't say.
 */
function narratesNextLine(
  sourceFile: ts.SourceFile,
  block: CommentBlock,
  content: string,
): boolean {
  const lineStarts = sourceFile.getLineStarts();
  const nextLineStart = lineStarts[block.endLine + 1];
  if (nextLineStart === undefined) return false;
  const nextLineEnd = lineStarts[block.endLine + 2] ?? sourceFile.getFullText().length;
  const codeLine = sourceFile.getFullText().slice(nextLineStart, nextLineEnd).trim();
  if (codeLine === '') return false;

  const codeTokens = new Set([...codeLine.matchAll(WORD)].map((m) => m[0].toLowerCase()));
  if (codeTokens.size < 2) return false;
  const ngrams = commentNgrams(content);
  let overlap = 0;
  for (const token of codeTokens) {
    if (ngrams.has(token)) overlap++;
  }
  return overlap / codeTokens.size >= 0.6;
}

export function findLlmTellsInFile(
  sourceFile: ts.SourceFile,
  input: LlmTellsInput = {},
): Finding[] {
  const minScore = input.minScore ?? 1;
  const text = sourceFile.getFullText();
  const findings: Finding[] = [];

  for (const block of toBlocks(sourceFile, collectCommentRanges(sourceFile))) {
    const content = contentOf(text.slice(block.pos, block.end));
    const matches: string[] = [];
    let score = 0;

    for (const tell of FILLERS) {
      if (tell.pattern.test(content)) {
        matches.push(tell.id);
        score += tell.weight;
      }
    }
    if (CHANGELOG.pattern.test(content)) {
      matches.push(CHANGELOG.id);
      score += CHANGELOG.weight;
    }
    if (block.kind === 'line-block' && narratesNextLine(sourceFile, block, content)) {
      matches.push('narration');
      score += NARRATION_WEIGHT;
    }
    if (score < minScore || matches.length === 0) continue;

    findings.push({
      file: sourceFile.fileName,
      range: {
        start: sourceFile.getLineAndCharacterOfPosition(block.pos),
        end: sourceFile.getLineAndCharacterOfPosition(block.end),
      },
      code: 'comment.llm-tell',
      message: `Comment reads like generated filler (${matches.join(', ')}). Rewrite to state only what the code cannot say, or delete.`,
      severity: 'info',
      data: { name: truncateFlat(content, MAX_NAME_CHARS), score, matches },
    });
  }
  return findings;
}

export const llmTells: Tool<LlmTellsInput, Finding[], TsProjectSession> = {
  name: 'ts/comments/llm-tells',
  description:
    'Finds comments with LLM-generated hallmarks: filler phrasing ("it\'s worth noting", ' +
    '"seamlessly", "delve"), change-log prose describing the edit instead of the code, ' +
    'and narration comments that restate the line below them. Patterns and weights live ' +
    'in patterns.ts; findings report the matched pattern ids and summed score.',
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
