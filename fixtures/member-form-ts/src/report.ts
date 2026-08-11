import type { Gauge } from './gauge.js';

export class Report {
  constructor(private readonly gauge: Gauge) {}

  /** Human-readable heading. */
  getTitle(): string {
    return `report ${this.gauge.id}`;
  }

  getRows(limit: number): string[] {
    return [this.getTitle()].slice(0, limit);
  }

  emit(): string {
    return `# ${this.getTitle()}`;
  }
}
