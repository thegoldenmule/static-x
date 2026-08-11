export const isTerminal = (level: number): boolean => level === 0;

export function isEnabled(level: number): boolean {
  if (level > 3) {
    return true;
  }
  return level === 2;
}
