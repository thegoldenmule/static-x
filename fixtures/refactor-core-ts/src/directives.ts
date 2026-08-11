'use client';

export function widget(): string {
  return 'widget';
}

export async function lazily(): Promise<string> {
  const module = await import('./square.js');
  return module.Square.name;
}

export function plainString(): string {
  const label = 'not a directive';
  return label;
}
