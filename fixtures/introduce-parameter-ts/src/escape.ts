export function tag(text: string): string {
  return '#'.concat(text);
}

/**
 * `tag` handed to map as a value. Arity is checked by assignability, so
 * an added parameter compiles here and silently starts receiving map's
 * index argument.
 */
export function tagAll(lines: string[]): string[] {
  return lines.map(tag);
}
