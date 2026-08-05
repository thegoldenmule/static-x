// Consumed only via `import * as geometry`, which keeps every export
// alive, including TAU, which nothing references directly.
export const TAU = 6.283185307179586;

export function area(radius: number): number {
  return (TAU / 2) * radius * radius;
}
