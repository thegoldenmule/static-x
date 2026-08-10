export abstract class Shape {
  abstract area(): number;

  describe(): string {
    return `area ${String(this.area())}`;
  }
}

export interface Drawable {
  draw(): string;
}
