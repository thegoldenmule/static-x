export class Report {
  constructor(protected readonly rows: string[]) {}

  render(): string {
    return this.rows.join('\n');
  }

  /** Left over from the table renderer; nothing calls it. */
  private pad(value: string): string {
    return value.padEnd(12, ' ');
  }
}

export class CsvReport extends Report {
  render(): string {
    return this.rows.join(',');
  }
}
