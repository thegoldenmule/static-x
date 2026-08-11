/**
 * What a command needs of its surroundings. It lives in its own module
 * rather than beside the runner because every command imports it while
 * the runner imports every command — with the type declared there, that
 * is an import cycle, erased at runtime but tangled all the same.
 */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Base for the paths text output prints. Default: process.cwd(). */
  cwd?: string;
  /** Reads all of stdin, for `--files-from -` and Claude Code events. */
  readStdin?(): Promise<string>;
}
