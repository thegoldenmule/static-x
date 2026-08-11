import { Crate } from './crate.js';

/** Reads one weight through a pattern and the other through a dot. */
export function weights(crate: Crate): number[] {
  const { tare } = crate;
  return [tare, crate.net];
}

export function pack(crate: Crate): number {
  crate.fill({ net: 4, tare: 2 });
  return crate.gross();
}
