interface Shift {
  readonly hours: number;
}

export class Warden {
  readonly badge: string;

  constructor(badge: string) {
    this.badge = badge;
  }

  shift(): Shift {
    return { hours: 8 };
  }
}
