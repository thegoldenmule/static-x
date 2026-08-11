import { Layout } from './config.js';

export function frame(layout: Layout, width: number): number {
  return width - layout.padding;
}

export function margin(layout: Layout, width: number): number {
  return width - layout.outer;
}

export function version(): number {
  return Layout.VERSION;
}
