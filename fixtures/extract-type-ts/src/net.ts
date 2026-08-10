export function connect(target: { host: string; port: number }): string {
  return `${target.host}:${String(target.port)}`;
}

/** The same shape again, in the same file — the dedupe case. */
export function listen(on: { host: string; port: number }): void {
  void on;
}

/** A different shape that shapeKey would wrongly conflate with those. */
export function label(of: { name: string; rank: number }): string {
  return `${of.name}#${String(of.rank)}`;
}

export function pick<T>(box: { value: T; tag: string }): T {
  return box.value;
}

export type Listener = (event: { kind: string; at: number }) => void;
