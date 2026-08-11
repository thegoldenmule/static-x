export interface Point {
  x: number;
  y: number;
}

export const ORIGIN: Point = { x: 0, y: 0 };

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}
