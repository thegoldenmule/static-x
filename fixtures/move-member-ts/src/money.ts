export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '-');
}
