function track(_target: unknown, _key: string): void {
  // A decorator observes the property at class-definition time.
}

export class Tracked {
  @track
  readonly level = 3;

  report(): number {
    return this.level;
  }
}
