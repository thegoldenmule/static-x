async function refresh(): Promise<void> {
  return;
}

function report(err: unknown): void {
  void err;
}

function onDone(): void {
  return;
}

export async function main(): Promise<void> {
  refresh();
  await refresh();
  void refresh();
  refresh().catch(report);
  refresh().then(onDone, report);
  refresh().then(onDone);
}
