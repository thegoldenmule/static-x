export function usedHelper(label: string): string {
  return `used:${label}`;
}

export function unusedHelper(): number {
  return 42;
}

export interface UnusedOptions {
  verbose: boolean;
}
