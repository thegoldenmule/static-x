import type { Envelope } from './types.js';

interface Frame {
  id: string;
  seq: number;
  redundant: boolean;
}

export function route(envelope: Envelope): string {
  return `${envelope.frame.id}#${String(envelope.frame.seq)}`;
}

export function localFrame(): Frame {
  return { id: 'x', seq: 0, redundant: false };
}
