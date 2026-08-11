export interface Located {
  readonly town: string;
}

export class Site {
  readonly town = 'unknown';
}

export class Annex extends Site implements Located {
  slots = 4;

  /** Overloaded on purpose: two signatures and one implementation. */
  find(index: number): string;
  find(label: string): string;
  find(key: number | string): string {
    return `${this.town}/${String(key)}`;
  }

  get full(): boolean {
    return this.slots === 0;
  }

  set full(value: boolean) {
    this.slots = value ? 0 : 4;
  }
}

export function label(annex: Annex): string {
  return annex.find(0);
}

export class Wing extends Site {
  beds = 2;
}

/** Reads a member Wing inherits rather than declares. */
export function town(wing: Wing): string {
  return wing.town;
}
