/**
 * Collapses whitespace runs and cuts to maxChars for finding names and
 * previews. These must be typeable in static-x.json ignore lists:
 * source snippets span lines (so runs collapse to one space) and the
 * cut never splits a surrogate pair — a lone high surrogate is
 * ill-formed Unicode that strict encoders reject and no user could
 * type.
 */
export function truncateFlat(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ');
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
