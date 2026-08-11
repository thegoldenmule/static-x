/**
 * Formats one log line. The severity is written into the body twice —
 * once as the tag and once as the prefix already-tagged input is
 * matched against — so a parameter has to replace both.
 *
 * @param message The text to write.
 */
export function log(message: string): string {
  const tag = 'info'.toUpperCase();
  return message.startsWith('info') ? message : `[${tag}] ${message}`;
}
