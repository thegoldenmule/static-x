import type { Box, Id, Reading, Slug, Tag } from './types.js';

export function trimSlug(value: Slug): Slug {
  return value.trim();
}

export const ids: Id[] = [1, 'two'];

/**
 * The silent case: written as `string | number[]` this alias still
 * compiles, and `firstId` starts accepting a bare string.
 */
export type Ids = Id[];

export function firstId(list: Ids): Id | undefined {
  return list[0];
}

export type Maybe = Id | undefined;

export type Lookup = Record<string, Id>;

export type Crate = Box<string>;

export function label(id: Id, tag: Tag): string {
  return `${String(id)}:${tag}`;
}

export function peak(readings: Reading[]): number {
  return Math.max(...readings.map((reading) => reading.value));
}
