export class Invoice {
  total = 0;

  readonly lines: string[] = [];

  add(line: string): void {
    this.lines.push(line);
  }
}

/** A destination that already declares `record`. */
export class Ledger {
  record(): string {
    return 'ledger';
  }
}
