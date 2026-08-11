import { MARKER } from './hidden.js';

/** `Marker` is not imported here, so its name cannot be written. */
export function mark(text: string): string {
  return `${MARKER.id}:${text}`;
}

export function marked(): string {
  return mark('x');
}
