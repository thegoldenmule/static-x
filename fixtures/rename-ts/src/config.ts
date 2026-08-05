export interface Options {
  retries: number;
}

export function makeOptions(retries: number): Options {
  return { retries };
}
