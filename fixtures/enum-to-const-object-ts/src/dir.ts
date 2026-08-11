export enum Dir {
  Up,
  Down,
}

export function step(dir: Dir): number {
  return dir === Dir.Up ? -1 : 1;
}

/** Reads the runtime object, which a numeric enum fills with both names and numbers. */
export const names: string[] = Object.keys(Dir);
