import { Status } from './status.js';

/** Body reads an imported binding; the call is in this same file. */
function isDone(status: Status): boolean {
  return status === Status.Ready;
}

export function check(status: Status): string {
  return isDone(status) ? 'done' : 'waiting';
}
