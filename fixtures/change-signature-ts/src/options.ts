export function makeOptions(host: string, port: number, secure: boolean): string {
  return `${host}:${String(port)}:${String(secure)}`;
}

/** Only ever called, and from one place — the simple case. */
export function greet(name: string, loud: boolean): string {
  return loud ? `${name.toUpperCase()}!` : name;
}

/** Handed out as a value elsewhere, so its arity is checked by assignability. */
export function escaped(a: string, b: number): string {
  return `${a}${String(b)}`;
}

export function spreadTarget(a: string, b: number): string {
  return `${a}${String(b)}`;
}

/** Called from two byte-identical files, which collides TypeScript's dedupe. */
export function twinned(a: string, b: number, c: boolean): string {
  return `${a}${String(b)}${String(c)}`;
}
