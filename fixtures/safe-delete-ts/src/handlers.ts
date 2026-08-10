type Handler = () => string;

const registry: Record<string, Handler | undefined> = {};

/** Clears the cached session. The wire protocol names it as a string. */
export function resetSession(): string {
  return 'reset';
}

export function dispatch(command: string): string {
  const handler = registry[command] ?? registry['resetSession'];
  return handler ? handler() : 'unknown';
}
