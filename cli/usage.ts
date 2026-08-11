/**
 * `--help` never reaches `parseArgs`, in any command. It is not declared
 * as an option anywhere, so parseArgs rejects it with a message about
 * positional arguments starting with a dash — the least useful possible
 * answer to the most common thing anyone types.
 *
 * This lives in its own module because every command needs it and the
 * runner imports every command: declared beside the runner, it is an
 * import cycle with a value edge, which is a genuinely fragile one.
 */
export function isHelpFlag(arg: string): boolean {
  return arg === '--help' || arg === '-h';
}
