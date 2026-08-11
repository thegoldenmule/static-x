import { Shape } from './geometry.js';
import { round2 } from './round.js';

export class Rectangle extends Shape {
  constructor(
    originX: number,
    originY: number,
    readonly width: number,
    readonly height: number,
  ) {
    super(originX, originY);
  }

  area(): number {
    return this.width * this.height;
  }

  /** Rectangles measure reach from their far corner. */
  reach(x: number, y: number): number {
    return Math.abs(x - this.originX) + Math.abs(y - this.originY);
  }

  /** How far the shape sits from the canvas origin. */
  offset(): number {
    return Math.abs(this.originX) + Math.abs(this.originY);
  }

  /** That distance, rounded for display. */
  offsetLabel(): string {
    return round2(Math.abs(this.originX) + Math.abs(this.originY));
  }

  /** One origin coordinate, chosen at runtime. */
  originOf(key: 'originX' | 'originY'): number {
    return this[key];
  }

  /** The shape's label, shouted. */
  shout(): string {
    return `${super.label()}!`;
  }
}
