// Entry point via package.json "bin"; its own export is exempt. Calls
// the ambient global that ambient.ts (a script file) declares.
export async function main(): Promise<void> {
  const tasks = await import('./tasks');
  tasks.runAll();
  fixtureGlobal();
}
