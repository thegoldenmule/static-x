import { Channel } from './channel.js';
import type { Payload } from './types.js';

/** The badge a push notification carries. `@` means something else here. */
const MARK = '!';

export class PushChannel extends Channel {
  badge = 0;

  last = '';

  constructor() {
    super('push');
  }

  send(payload: Payload): void {
    this.badge += 1;
    this.label = payload.id;
    this.last = `${MARK}${this.label} ${this.signature()} ${this.stamp()} ${this.envelope(payload).text}`;
  }
}
