export class Printer {
  constructor(readonly prefix: string) {}

  wrap(text: string): string {
    return `${this.prefix}${text}`;
  }
}
