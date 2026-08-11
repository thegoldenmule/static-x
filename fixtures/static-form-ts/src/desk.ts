import { makeFormatter } from './factory.js';

const desk = { fmt: makeFormatter() };

export function deskLine(width: number): string {
  return desk.fmt.pad('desk', width);
}
