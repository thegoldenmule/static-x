export enum Rank {
  Bronze = 0,
  Silver = 1,
}

/** The reverse mapping: only a numeric enum's runtime object has it. */
export function rankName(value: number): string {
  return Rank[value] ?? 'unranked';
}

/** A forward access through a string key, which a plain object does just as well. */
export const bronze = Rank['Bronze'];
