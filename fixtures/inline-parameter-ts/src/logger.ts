/**
 * Formats one log line.
 *
 * @param message The text to write.
 * @param level Severity label printed alongside the message.
 */
export function log(message: string, level: string): string {
  return `[${level}] ${message}`;
}
