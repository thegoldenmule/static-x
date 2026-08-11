export class Registry {
  static readonly VERSION = 2;

  private entries: string[] = [];

  #seed = 0;

  protected note = 'internal';

  constructor() {
    this.entries.push('root');
  }

  private reset(): void {
    this.entries = [];
    this.#seed = 0;
  }

  static blank(): Registry {
    return new Registry();
  }
}
