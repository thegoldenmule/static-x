import type { Finding } from '../tool/index.js';
import { truncateFlat } from '../text/index.js';
import { positionAt } from '../text/index.js';
import type { CommentBlock, CommentFile } from './types.js';

export interface LongCommentsOptions {
  /** Flag blocks spanning more than this many lines. Default 10. */
  maxLines?: number;
  /** Flag blocks longer than this many characters. Default 800. */
  maxChars?: number;
  /** Matches a license header, which is conventionally long. */
  license: RegExp;
}

const DEFAULT_MAX_LINES = 10;
const DEFAULT_MAX_CHARS = 800;
/** data.name is the flattened comment head, the static-x.json ignore key. */
const MAX_NAME_CHARS = 60;

export function findLongComments(
  file: CommentFile,
  blocks: readonly CommentBlock[],
  options: LongCommentsOptions,
): Finding[] {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const findings: Finding[] = [];

  for (const block of blocks) {
    const lines = block.endLine - block.startLine + 1;
    const chars = block.end - block.pos;
    if (lines <= maxLines && chars <= maxChars) continue;
    // License/copyright headers are conventionally long; skip them.
    if (block.end <= file.firstCodeOffset && options.license.test(file.text.slice(block.pos, block.end)))
      continue;

    const reason =
      lines > maxLines
        ? `spans ${lines} lines (limit ${maxLines})`
        : `is ${chars} characters (limit ${maxChars})`;
    findings.push({
      file: file.file,
      range: {
        start: { line: block.startLine, character: 0 },
        end: positionAt(file.lineStarts, block.end),
      },
      code: 'comment.long',
      message: `Comment block ${reason}. Long comments often restate code or hide stale context; consider tightening or deleting.`,
      severity: 'info',
      data: {
        name: truncateFlat(file.text.slice(block.pos, block.end), MAX_NAME_CHARS),
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
