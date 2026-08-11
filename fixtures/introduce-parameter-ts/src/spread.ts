export function join(a: string, b: string): string {
  return [a, '-', b].join('');
}

const parts: [string, string] = ['x', 'y'];

export function joined(): string {
  return join(...parts);
}
