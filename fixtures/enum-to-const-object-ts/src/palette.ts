import { Color } from './barrel.js';

/** Reached through the barrel, and used as both a type and a value. */
export function temperature(color: Color): string {
  switch (color) {
    case Color.Red:
      return 'warm';
    case Color.Blue:
      return 'cold';
  }
}

export const weights: Record<Color, number> = { red: 1, blue: 2 };

export const warmest: Color = Color.Red;
