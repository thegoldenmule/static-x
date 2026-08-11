export interface Entry {
  level: number;
  text: string;
}

/** A destructured parameter carrying defaults inside the pattern. */
export class Buffer {
  private readonly entries: Entry[] = [];

  add(entry: Entry): void {
    this.entries.push(entry);
  }

  recent({ minLevel = 0, limit = 20 }: { minLevel?: number; limit?: number } = {}): Entry[] {
    return this.entries.filter((entry) => entry.level >= minLevel).slice(0, limit);
  }
}
