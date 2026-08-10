import { escaped } from './options.js';

/** A value-position reference: TypeScript silently returns no edits here. */
export const indirect: typeof escaped = escaped;

export const joined = ['a', 'b'].map((s) => escaped(s, 1));
