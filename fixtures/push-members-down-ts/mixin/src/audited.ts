import { Feed } from './feed.js';

type Constructor = new (...args: any[]) => object;

export function WithAudit<T extends Constructor>(base: T) {
  return class extends base {
    audited = true;
  };
}

/**
 * The heritage clause is a call expression, so no class symbol resolves
 * from it — the scan cannot tell whether this derives from Feed, and it
 * names Feed, so a push down off Feed has to refuse.
 */
export class AuditedFeed extends WithAudit(Feed) {
  summary(): string {
    return `${this.hydrate()} ${this.audited}`;
  }
}
