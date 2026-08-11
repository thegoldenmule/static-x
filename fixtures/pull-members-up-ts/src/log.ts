export class Sink {
  protected lines: string[] = [];

  /** Everything buffered so far, as one string. */
  flush(): string {
    return this.lines.join('\n');
  }
}

export class FileSink extends Sink {
  /** Adds one line to the buffer. */
  write(line: string): void {
    this.lines.push(line);
  }

  /** Number of buffered lines. */
  get pending(): number {
    return this.lines.length;
  }
}
