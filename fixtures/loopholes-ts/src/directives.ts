export function tolerate(): number {
  // @ts-expect-error deliberate mismatch keeps this directive exercised
  const wrong: number = 'mismatch';
  return wrong;
}

export function force(): string {
  // @ts-ignore
  const text: string = 123;
  return text;
}

export const DIRECTIVE_NOTE = 'never write @ts-ignore inside strings';
