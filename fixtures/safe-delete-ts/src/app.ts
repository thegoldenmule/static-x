import { formatLabel, slugify } from './formatting.js';

export function pageId(title: string): string {
  return slugify(title);
}
