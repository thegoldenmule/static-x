export function report(verbose: boolean, label: string): string {
  if (verbose) {
    return `${label}: full`;
  }
  return label;
}
