import type { Payload } from './casts.js';

export function fakePayload(): Payload {
  return { id: 'fixture', size: 1 } as Payload;
}
