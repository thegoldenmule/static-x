const base = 2;

/** Both fold to constants, and both widen to `number` under `as const`. */
export enum Size {
  Small = base,
  Large = base * 2,
}

export enum Length {
  Short = 'short'.length,
}

export const sizes: number[] = [Size.Small, Size.Large, Length.Short];
