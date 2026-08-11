import * as types from './types.js';

export const empty: types.Id = types.EMPTY_ID;

export function stage(tag: types.Tag): string {
  return tag;
}
