/**
 * Prefixes a line with its position.
 *
 * @param text The line to prefix.
 * @param index Position written in front of the line.
 */
export function tag(text: string, index: number): string {
  return `${index}: ${text}`;
}

/**
 * `tag` handed to map as a value. Arity is checked by assignability, so
 * dropping `index` still compiles here and every line silently loses the
 * position map was passing it.
 */
export function labelAll(lines: string[]): string[] {
  return lines.map(tag);
}

export function labelOne(line: string): string {
  return tag(line, 0);
}

export function labelTwo(line: string): string {
  return tag(line, 0);
}
