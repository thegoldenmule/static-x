export type Id = string | number;

export type Tag = 'draft' | 'live';

export type Millis = number;

export type Named = { name: string };

export type Tree = { label: string; children: Tree[] };

export type Box<T> = { value: T };

export type Unused = boolean;

export type Slug = string; export const SLUG_MAX = 64;

export interface Packet {
  id: string;
  bytes: number;
}

/** A right-hand side that is one type reference: nothing to parenthesize. */
export type Datagram = Packet;

interface Sensor {
  id: string;
}

/** Names `Sensor`, which this module declares but does not export. */
export type Reading = { source: Sensor; value: number };

interface Frame {
  id: string;
  seq: number;
}

/** Names `Frame`, a name another module happens to declare too. */
export type Envelope = { frame: Frame; at: number };

export const EMPTY_ID: Id = '';

export function depth(tree: Tree): number {
  return tree.children.length;
}
