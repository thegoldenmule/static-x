const TEST_FILE = /\.(?:test|spec)\.[cm]?tsx?$/;

/**
 * `*.test.*` / `*.spec.*` TypeScript files (.ts/.tsx/.mts/.cts).
 * Shared by every tool that treats test scaffolding specially; why a
 * tool skips or keeps tests is its own call, documented at its
 * isTestFile call site or on its includeTests option.
 */
export function isTestFile(fileName: string): boolean {
  return TEST_FILE.test(fileName);
}
