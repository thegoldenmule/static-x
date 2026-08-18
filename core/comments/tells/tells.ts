import type { Finding } from '../../tool/index.js';
import { truncateFlat } from '../../text/index.js';
import { positionAt } from '../../text/index.js';
import type { CommentBlock, CommentFile } from '../types.js';
import { CHANGELOG, FILLERS, NARRATION_WEIGHT } from './patterns.js';

/** Ignore-filter key length; matches core/comments/long. */
const MAX_NAME_CHARS = 60;

interface LlmTellsOptions {
  /** Minimum summed pattern weight to flag a comment. Default 1. */
  minScore?: number;
  /** Strip this language's comment markers, leaving the prose. */
  contentOf(raw: string): string;
  /**
   * Which blocks the narration check applies to. A doc comment is
   * supposed to name what it documents, so it never narrates.
   */
  narratable(block: CommentBlock): boolean;
}

const WORD = /[A-Za-z_$][\w$]*/g;

/**
 * Words of the comment plus concatenations of 2-3 consecutive words,
 * lowercased, so the two words "total count" can match a single
 * camelCased identifier in the line below.
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
function narratesNextLine(file: CommentFile, block: CommentBlock, content: string): boolean {
  const nextLineStart = file.lineStarts[block.endLine + 1];
  if (nextLineStart === undefined) return false;
  const nextLineEnd = file.lineStarts[block.endLine + 2] ?? file.text.length;
  const codeLine = file.text.slice(nextLineStart, nextLineEnd).trim();
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

export function findLlmTells(
  file: CommentFile,
  blocks: readonly CommentBlock[],
  options: LlmTellsOptions,
): Finding[] {
  const minScore = options.minScore ?? 1;
  const findings: Finding[] = [];

  for (const block of blocks) {
    const content = options.contentOf(file.text.slice(block.pos, block.end));
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
    if (options.narratable(block) && narratesNextLine(file, block, content)) {
      matches.push('narration');
      score += NARRATION_WEIGHT;
    }
    if (score < minScore || matches.length === 0) continue;

    findings.push({
      file: file.file,
      range: {
        start: positionAt(file.lineStarts, block.pos),
        end: positionAt(file.lineStarts, block.end),
      },
      code: 'comment.llm-tell',
      message: `Comment reads like generated filler (${matches.join(', ')}). Rewrite to state only what the code cannot say, or delete.`,
      severity: 'info',
      data: { name: truncateFlat(content, MAX_NAME_CHARS), score, matches },
    });
  }
  return findings;
}
