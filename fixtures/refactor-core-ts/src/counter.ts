export class Counter {
  count = 0;
  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  bump(): void {
    this.count += 1;
  }

  reset(): void {
    this.count = 0;
  }
}

export function scale(value: number, factor: number): number {
  return value * factor;
}

export type Scaler = typeof scale;
