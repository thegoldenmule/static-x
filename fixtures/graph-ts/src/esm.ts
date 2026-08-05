// Entry point via package.json "module"; its export is exempt.
export function esmEntry(): string {
  return 'esm';
}
