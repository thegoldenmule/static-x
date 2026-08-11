import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Finding } from '../tool/index.js';

/**
 * A record of what a project's findings were when the gate was turned
 * on, so a suite can report only what came after. This is the half of
 * the novelty problem that changed-lines cannot solve: `graph/cycles`
 * anchors its finding on one representative file of the cycle and
 * `graph/dead-exports` reports in the file that *declares* the export,
 * so neither has a line the change touched. A whole-project suite needs
 * a remembered "before" instead.
 *
 * The file is meant to be committed. It is also meant to shrink: every
 * entry is a finding someone decided not to fix yet, and `static-x
 * baseline` rewrites it from scratch, so an entry that no longer
 * reproduces disappears rather than lingering as a permanent excuse.
 */

export const BASELINE_FILENAME = 'static-x-baseline.json';

interface BaselineFile {
  version: 1;
  /** Fingerprint to the number of times it occurred. */
  findings: Record<string, number>;
}

export type Baseline = ReadonlyMap<string, number>;

/**
 * Identity for a finding that survives the edits around it. Line and
 * column are deliberately excluded — code moves, and a baseline that
 * forgot a finding every time something above it grew a line would be
 * worse than none.
 *
 * `data.name` is the tool's own identity for what it found (the symbol,
 * the type, the cycle's anchor); it is already the key `ignore` matches
 * on, so every tool that can name a finding does. The message is the
 * fallback, with digits collapsed because several tools interpolate
 * positions and counts into their prose.
 */
export function fingerprint(finding: Finding, rootPath: string): string {
  const file = path.relative(rootPath, finding.file) || path.basename(finding.file);
  const name = finding.data?.['name'];
  const identity =
    typeof name === 'string' && name !== ''
      ? name
      : finding.message.replace(/\d+/g, '#').slice(0, 120);
  // Posix separators so a baseline written on one platform matches on
  // another; the file is committed and CI is rarely the author's OS.
  return `${file.split(path.sep).join('/')}|${finding.code}|${identity}`;
}

export function tally(findings: readonly Finding[], rootPath: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const key = fingerprint(finding, rootPath);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function baselinePath(rootPath: string): string {
  return path.join(rootPath, BASELINE_FILENAME);
}

/** Reads the baseline, or undefined when the project has none. */
export async function loadBaseline(rootPath: string): Promise<Baseline | undefined> {
  const file = baselinePath(rootPath);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const findings = (parsed as Partial<BaselineFile> | null)?.findings;
  if (findings === null || typeof findings !== 'object' || Array.isArray(findings)) {
    throw new Error(`Invalid baseline in ${file}: expected a "findings" object`);
  }
  const counts = new Map<string, number>();
  for (const [key, count] of Object.entries(findings)) {
    if (typeof count === 'number' && Number.isFinite(count)) counts.set(key, count);
  }
  return counts;
}

export async function writeBaseline(
  rootPath: string,
  findings: readonly Finding[],
): Promise<{ file: string; entries: number }> {
  const counts = tally(findings, rootPath);
  const file = baselinePath(rootPath);
  const sorted = Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const contents: BaselineFile = { version: 1, findings: sorted };
  await writeFile(file, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
  return { file, entries: counts.size };
}

/**
 * The findings the baseline does not already account for. Counts rather
 * than presence: three `as any` in a file where the baseline recorded
 * two means one is new, and which of the three is the new one is not a
 * question the fingerprint can answer — nor one worth answering, since
 * the author is looking at all three either way.
 */
export function notInBaseline(
  findings: readonly Finding[],
  baseline: Baseline,
  rootPath: string,
): Finding[] {
  const remaining = new Map(baseline);
  const fresh: Finding[] = [];
  for (const finding of findings) {
    const key = fingerprint(finding, rootPath);
    const budget = remaining.get(key) ?? 0;
    if (budget > 0) remaining.set(key, budget - 1);
    else fresh.push(finding);
  }
  return fresh;
}
