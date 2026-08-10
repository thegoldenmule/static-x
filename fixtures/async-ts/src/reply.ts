/**
 * Mimics Fastify's FastifyReply: a fluent response builder whose
 * instances are thenable, so discarding one looks exactly like a
 * floating promise to type-level analysis.
 */
export class Reply {
  #headers = new Map<string, string>();

  header(name: string, value: string): Reply {
    this.#headers.set(name, value);
    return this;
  }

  then(onFulfilled?: () => void, onRejected?: (reason: unknown) => void): void {
    void this.#headers;
    void onRejected;
    onFulfilled?.();
  }
}

export function handle(reply: Reply): void {
  reply.header('x-request-id', 'abc123');
}
