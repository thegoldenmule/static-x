// Consumed only via a bare side-effect import: the file stays alive,
// but sideNote is still an unused export.
export function sideNote(): string {
  return 'side';
}
