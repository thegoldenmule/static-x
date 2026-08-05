import { makeOptions } from './config.js';

export function totalRetries(): number {
  const options = makeOptions(3);
  return options.retries * 2;
}
