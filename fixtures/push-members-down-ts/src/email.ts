import { Channel } from './channel.js';
import type { Payload } from './types.js';

export class EmailChannel extends Channel {
  readonly sent: string[] = [];

  constructor() {
    super('email');
  }

  send(payload: Payload): void {
    const envelope = this.envelope(payload);
    this.sent.push(`${this.signature()} ${envelope.text} x${this.retries} ${this.audit()}`);
  }

  trace(): string {
    return `email trace ${this.name}`;
  }
}
