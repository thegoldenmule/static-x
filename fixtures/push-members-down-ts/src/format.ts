export const BULLET = '*';

export const MARK = '@';

export function pad(text: string, width: number): string {
  return text.padEnd(width, ' ');
}
