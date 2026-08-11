export class Label {
  constructor(readonly text: string) {}

  /** The candidate receiver has a default, so a call site may omit it. */
  static render(prefix: string, label: Label = new Label('')): string {
    return `${prefix}${label.text}`;
  }
}
