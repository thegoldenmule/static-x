import { formatLabel } from './formatting.js';
import { pageId } from './app.js';

export function heading(title: string): string {
  return pageId(title);
}
