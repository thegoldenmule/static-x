export function pad(text: string): string {
  const width = 4;
  return text.padStart(width + 2);
}

export function padded(): string {
  return pad('x');
}
