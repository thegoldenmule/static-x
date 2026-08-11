import ts from 'typescript';

/**
 * Keeping relocated code looking like the code around it.
 *
 * A refactoring that moves text between nesting levels has to re-indent
 * it, and the interesting part is what must be left alone: only the
 * leading whitespace a line had at its old depth is replaced. Anything
 * past that column is content — including, crucially, the interior of a
 * multi-line template literal, where indentation is part of the string
 * and shifting it changes the value with nothing a typecheck could
 * notice.
 */

/**
 * Re-indent `text` from an original leading width of `from` to the
 * literal prefix `to`. The first line is prefixed as-is, since it
 * begins where the caller places it; blank lines stay blank rather
 * than becoming trailing whitespace.
 */
export function reindent(text: string, from: number, to: string): string {
  return text
    .split('\n')
    .map((line, index) => {
      if (index === 0) return to + line;
      const stripped = line.slice(0, from).replace(/^[ \t]*/, '') + line.slice(from);
      return stripped.length === 0 ? '' : to + stripped;
    })
    .join('\n');
}

/** Offsets into a file. */
export interface Span {
  start: number;
  end: number;
}

/**
 * The spans that remove declarations along with the lines they occupy.
 *
 * Two things make this more than "take the line". Blank lines above a
 * declaration belong to it — leaving them behind opens a hole where it
 * used to be — and when a declaration is the first thing inside a
 * container, the blank line *after* it belongs to it too, or the
 * container opens on an empty line.
 *
 * Removing several members at once is where a naive version breaks:
 * two adjacent members each claiming the blank line between them
 * produce overlapping spans, which `applyTextEdits` rejects outright.
 * So spans are merged, and the forward sweep is bounded by the next
 * span rather than running into it.
 */
export function removalSpans(sourceFile: ts.SourceFile, nodes: readonly ts.Node[]): Span[] {
  const text = sourceFile.getFullText();
  const lineStartAt = (offset: number): number => {
    let at = offset;
    while (at > 0 && text[at - 1] !== '\n') at--;
    return at;
  };

  const raw = nodes
    .map((node) => {
      let start = lineStartAt(node.getStart(sourceFile, true));
      while (start > 0) {
        const previous = lineStartAt(start - 1);
        if (text.slice(previous, start).trim() !== '') break;
        start = previous;
      }
      let end = node.getEnd();
      while (end < text.length && text[end] !== '\n') end++;
      if (end < text.length) end++;
      return { start, end };
    })
    .sort((a, b) => a.start - b.start);

  const merged: Span[] = [];
  for (const span of raw) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  for (const [index, span] of merged.entries()) {
    if (!text.slice(0, span.start).trimEnd().endsWith('{')) continue;
    const limit = merged[index + 1]?.start ?? text.length;
    for (;;) {
      const lineEnd = text.indexOf('\n', span.end);
      if (lineEnd === -1 || lineEnd + 1 > limit) break;
      if (text.slice(span.end, lineEnd).trim() !== '') break;
      span.end = lineEnd + 1;
    }
  }
  return merged;
}

/** The blank lines a removal span opens above and below itself. */
export function blankLinesAround(text: string, span: Span): { before: string; after: string } {
  const lines = text.slice(span.start, span.end).split('\n');
  let before = 0;
  while (before < lines.length - 1 && lines[before]!.trim() === '') before++;
  let after = 0;
  for (let index = lines.length - 2; index > before && lines[index]!.trim() === ''; index--) {
    after++;
  }
  return { before: '\n'.repeat(before), after: '\n'.repeat(after) };
}
