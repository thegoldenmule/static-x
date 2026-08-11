import { Circle } from './circle.js';
import { Rectangle } from './rectangle.js';

/** Call sites survive a pull-up untouched: inheritance keeps them resolving. */
export function report(circle: Circle, rectangle: Rectangle): string {
  return `${circle.reach(0, 0)} ${rectangle.reach(0, 0)} ${circle.area()}`;
}
