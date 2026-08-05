// Shape is consumed by a type-only import in tasks.ts; DeadShape is dead.
export interface Shape {
  kind: string;
}

export interface DeadShape {
  sides: number;
}
