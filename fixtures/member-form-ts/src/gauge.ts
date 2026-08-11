export class Gauge {
  reading = 0;

  private _serial = 'g-0';

  constructor(readonly id: string) {}

  double(): void {
    this.reading = this.reading * 2;
  }

  stamp(): string {
    return `${this._serial}/${this.reading}`;
  }
}
