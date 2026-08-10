import { slugify, formatLabel } from './formatting.js';

export function pageIds(titles: string[]): string[] {
  return titles.map((title) => slugify(title));
}
