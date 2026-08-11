import type { Box } from './box.js';

export class Crate {
  /** The candidate receiver is a Box, not a Crate. */
  static stamp(box: Box, mark: string): string {
    return `${box.id}${mark}`;
  }
}
