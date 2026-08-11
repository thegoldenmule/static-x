import type { Drawable } from './drawable.js';
import { Shape } from './geometry.js';
import { distance, type Point } from './point.js';

/** A wedge of a circle, by angle. Deliberately not exported. */
interface Sector {
  from: number;
  to: number;
}

export class Circle extends Shape implements Drawable {
  /** The unit every shape measures in. */
  static readonly unit = 'px';

  #serial = 0;

  private precision = 2;

  constructor(
    originX: number,
    originY: number,
    readonly radius: number,
  ) {
    super(originX, originY);
  }

  area(): number {
    return Math.PI * this.radius ** 2;
  }

  /** Distance from the shape's origin to a point on the canvas. */
  reach(x: number, y: number): number {
    return distance(this.originX, this.originY, x, y);
  }

  /** Where the shape's edge sits on a bearing. */
  edge(bearing: number): Point {
    return {
      x: this.originX + Math.cos(bearing) * this.radius,
      y: this.originY + Math.sin(bearing) * this.radius,
    };
  }

  /** Area of one wedge. */
  slice(sector: Sector): number {
    return ((sector.to - sector.from) / (2 * Math.PI)) * this.area();
  }

  /** A number at the precision this class prefers. */
  rounded(value: number): string {
    return value.toFixed(this.precision);
  }

  /** Next serial number for this circle. */
  stamp(): number {
    this.#serial += 1;
    return this.#serial;
  }
}
