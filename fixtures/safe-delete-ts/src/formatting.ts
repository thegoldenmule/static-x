/**
 * Human-readable label for a slug.
 *
 * The UI renders slugs directly now, so nothing calls this.
 */
export function formatLabel(slug: string): string {
  return slug.replace(/-/g, ' ');
}

export function slugify(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, '-');
}
