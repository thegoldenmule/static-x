/** One newline-delimited JSON message each way. */
export interface DaemonRequest {
  id: number;
  tool: string;
  projectRoot: string;
  input: unknown;
  /** Ask the daemon to exit after answering. Used by tests. */
  shutdown?: boolean;
}

export type DaemonResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** How often a daemon checks that it is still reachable. */
export const REACHABILITY_INTERVAL_MS = 15 * 1000;

/** Frame a message. Newline-delimited, so a partial read is detectable. */
export function encode(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Split a buffer into complete messages and whatever tail is left. A
 * response can exceed one chunk, and treating a partial read as a
 * message would surface as a parse error rather than as the incomplete
 * read it is.
 */
export function decode(buffer: string): { messages: unknown[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  const messages: unknown[] = [];
  for (const part of parts) {
    if (part.trim() === '') continue;
    messages.push(JSON.parse(part));
  }
  return { messages, rest };
}
