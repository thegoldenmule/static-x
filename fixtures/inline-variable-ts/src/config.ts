/** A subtraction, so the read site decides whether it needs wrapping. */
export const OFFSET = 10 - 4;

/** No names at all, so it is portable into any file. */
export const LABEL = 'total';

/** Depends on a module-local constant that other files cannot see. */
const FACTOR = 3;
export const SCALED = FACTOR * 2;

/** Re-exported through the barrel, so deleting it breaks that line too. */
export const MARGIN = 8;

/** Read in a type position, where an expression cannot go. */
export const SHAPE = { width: 4 };
export type Shape = typeof SHAPE;

/** Exported and read nowhere in this project. */
export const PUBLIC_TIMEOUT = 30;
