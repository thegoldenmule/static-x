export function record(entry: any): string {
  return JSON.stringify(entry);
}

export const fallback: any = null;

export function firstUpper(names: string[]): string {
  return names[0]!.toUpperCase();
}
