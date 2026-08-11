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
