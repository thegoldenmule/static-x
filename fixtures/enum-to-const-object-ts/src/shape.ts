export enum Shape {
  Circle = 'circle',
  Square = 'square',
}

/** A single member used as a type — a namespace access no const object has. */
export interface Round {
  kind: Shape.Circle;
  radius: number;
}
