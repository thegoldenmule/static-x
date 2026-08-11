export enum Flags {
  Read = 1,
  Write = 2,
}

/** The bit-flag idiom: `|` yields `number`, which a numeric enum type accepts. */
export const readWrite: Flags = Flags.Read | Flags.Write;
