// usedWidget is imported by tasks.ts; the default export is dead and
// reported under its declaration name.
export function usedWidget(): string {
  return 'widget';
}

export default function unusedWidget(): number {
  return 4;
}
