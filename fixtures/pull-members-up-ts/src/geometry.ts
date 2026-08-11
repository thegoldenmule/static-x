import { ORIGIN } from './point.js';

/** Everything the renderer needs from a shape. */
export abstract class Shape {
  constructor(
    readonly originX: number,
    readonly originY: number,
  ) {}

  abstract area(): number;

  /** Where the shape sits, for logs. */
  label(): string {
    return `shape at ${this.originX},${this.originY}`;
  }

  /** Whether the shape sits at the canvas origin. */
  atOrigin(): boolean {
    return this.originX === ORIGIN.x && this.originY === ORIGIN.y;
  }
}
