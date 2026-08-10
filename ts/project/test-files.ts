const TEST_FILE = /\.(?:test|spec)\.[cm]?tsx?$/;

/**
 * `*.test.*` / `*.spec.*` TypeScript files (.ts/.tsx/.mts/.cts).
 * Shared by every tool that treats test scaffolding specially:
 * dead-exports because the runner, not imports, loads test exports;
 * dupes/functions because duplicate test setup is usually deliberate.
 */
export function isTestFile(fileName: string): boolean {
  return TEST_FILE.test(fileName);
}
