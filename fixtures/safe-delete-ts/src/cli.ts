/** Entry point named by the package.json "bin" field. */
export function main(argv: string[]): number {
  return argv.length;
}
