export interface Tag {
  label: string;
}

/** Anything that reports how full it is. */
export interface Counted {
  occupancy: number;
}
