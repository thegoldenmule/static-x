/** Referenced by a doc comment elsewhere, which makes TypeScript decline. */
export function instrument(target: string, label: string, verbose = false): string {
  return verbose ? `${target}/${label}!` : `${target}/${label}`;
}
