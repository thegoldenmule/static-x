import type { Position } from '../tool/index.js';

/** Offset of the first character of every line, `getLineStarts()`-shaped. */
export function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** The line/character an offset falls on. Binary search, so O(log n) per call. */
export function positionAt(lineStarts: readonly number[], offset: number): Position {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineStarts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, character: offset - lineStarts[low]! };
}
