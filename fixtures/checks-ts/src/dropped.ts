export async function work(): Promise<number> {
  return 1;
}

export function caller(): void {
  work();
}
