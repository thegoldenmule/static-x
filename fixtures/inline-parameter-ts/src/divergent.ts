export function retry(task: string, attempts: number): string {
  return `${task} x${attempts}`;
}

export function retrySync(): string {
  return retry('sync', 3);
}

export function retryIndex(): string {
  return retry('index', 5);
}
