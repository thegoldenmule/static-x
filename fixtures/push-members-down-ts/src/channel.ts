import { BULLET, MARK, pad } from './format.js';
import { Endpoint } from './endpoint.js';
import type { Envelope, Payload } from './types.js';

export abstract class Channel extends Endpoint {
  /** How many times a failed send is retried. */
  retries = 3;

  constructor(readonly name: string) {
    super();
  }

  /** How this channel signs the messages it sends. */
  signature(): string {
    return `${BULLET} ${pad(this.name, 8)} ${this.tagline()}`;
  }

  tagline(): string {
    return 'sent by static-x';
  }

  envelope(payload: Payload): Envelope {
    return { to: this.name, text: payload.body };
  }

  stamp(): string {
    return `${MARK}${this.name}`;
  }

  protected tag = '';

  get label(): string {
    return this.tag;
  }

  set label(value: string) {
    this.tag = value;
  }

  banner(): string {
    return `== ${this.name} ==`;
  }

  preview(): string {
    return `${this.name} preview`;
  }

  describe(): string {
    return `${this.banner()} channel`;
  }

  trace(): string {
    return `trace ${this.name}`;
  }

  private token(): string {
    return `${this.name}-token`;
  }

  audit(): string {
    return `audit ${this.token()}`;
  }

  ping(): string {
    return `channel ${this.name}`;
  }

  relay(): string {
    return `${super.ping()} relay`;
  }

  abstract send(payload: Payload): void;

  static brand(): string {
    return 'static-x';
  }
}
