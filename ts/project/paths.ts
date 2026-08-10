import path from 'node:path';

/**
 * Project-relative path with `/` separators — the one form used for
 * finding `data.name` values, peer lists, and `static-x.json` ignore
 * keys, so every tool renders the same key for the same file.
 */
export function toProjectRelative(rootPath: string, file: string): string {
  return path.relative(rootPath, file).split(path.sep).join('/');
}

/**
 * Whether a root-relative path (native separators, as `path.relative`
 * produces) passes through a hidden (dot-prefixed) directory. Only
 * directory segments count: a dot-file itself is not hidden output,
 * and a project root that lives under a dot-directory contributes no
 * segments here.
 */
export function hasHiddenDirSegment(relativePath: string): boolean {
  return relativePath
    .split(path.sep)
    .slice(0, -1)
    .some((segment) => segment.startsWith('.'));
}
