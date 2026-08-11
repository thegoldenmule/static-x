import type { Channel } from './channel.js';
import { EmailChannel } from './email.js';

/** Reads a member off the base type itself, which no subclass copy serves. */
export function announce(channel: Channel): string {
  return channel.preview();
}

export function ship(email: EmailChannel): string {
  return email.signature();
}
