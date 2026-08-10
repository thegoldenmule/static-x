import { Shape, type Drawable } from './shapes.js';

/** The base class arrives through an import, so its symbol is an alias. */
export class Square extends Shape implements Drawable {
  constructor(private readonly side: number) {
    super();
  }

  area(): number {
    return this.side * this.side;
  }

  draw(): string {
    return `square(${String(this.side)})`;
  }
}

export class Tile extends Square {
  area(): number {
    return super.area() * 2;
  }
}
