import type { Datagram, Packet } from './types.js';

export interface Stamped extends Datagram {
  checksum: string;
}

export function sizeOf(datagram: Datagram): number {
  return datagram.bytes;
}

export function wrap(packet: Packet): Datagram {
  return packet;
}
