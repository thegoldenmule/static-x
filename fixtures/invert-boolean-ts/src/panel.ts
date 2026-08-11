export class Panel {
  expanded = true;

  toggle(): void {
    this.expanded = !this.expanded;
  }

  summary(): string {
    return this.expanded ? 'open' : 'closed';
  }
}

export class Ticket {
  constructor(private readonly count: number) {}

  isEmpty(): boolean {
    return this.count === 0;
  }
}

export interface PanelState {
  docked: boolean;
}

export function initial(): PanelState {
  return { docked: false };
}
