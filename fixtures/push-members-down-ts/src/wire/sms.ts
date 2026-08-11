import { Channel } from '../channel.js';
import type { Payload } from '../types.js';

export class SmsChannel extends Channel {
  out = '';

  constructor() {
    super('sms');
  }

  send(payload: Payload): void {
    this.out = `${this.signature()} ${this.envelope(payload).text}`;
  }
}
