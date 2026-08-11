/** Round to the cent, so a running total never carries float noise. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function pad(text: string, width: number): string {
  return text.padEnd(width);
}
