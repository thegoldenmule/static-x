export function report(kind: string, detail?: string): string {
  return '!'.concat(kind, detail ?? '');
}

export function reported(): string {
  return report('x', 'y');
}
