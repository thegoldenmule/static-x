import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * What a change consists of, as the event that triggered a check knows
 * it: which files it touched, and — when the source can say — which
 * lines within them it added or rewrote.
 *
 * Lines are 0-based to match `Finding.range`, which is LSP-shaped.
 * Git speaks 1-based, so the parsing here converts once, at the edge.
 */
export interface ChangeSet {
  /** Absolute paths of the files the change touched. */
  files: string[];
  /**
   * Absolute path to the 0-based line numbers the change introduced.
   * Absent when the source knows the files but not the lines — a
   * Claude Code edit event, or a whole-branch push.
   */
  lines?: Map<string, Set<number>>;
}

/** A hunk header: `@@ -12,3 +14,5 @@`, whose `+14,5` is what we want. */
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const TARGET_FILE = /^\+\+\+ (?:b\/)?(.*)$/;

function git(args: string[], cwd: string): string | undefined {
  // core.quotePath=false keeps non-ASCII paths literal; without it git
  // escapes them and every path in the diff header needs unquoting.
  const run = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) return undefined;
  return run.stdout;
}

/** The repository root, or undefined outside a work tree. */
export function repoRoot(cwd: string): string | undefined {
  return git(['rev-parse', '--show-toplevel'], cwd)?.trim() || undefined;
}

/**
 * Parses a unified diff produced with zero context lines into the set
 * of lines each file gained. Zero context is what makes this precise:
 * with the default three lines of surrounding context, a hunk claims
 * lines the change never touched, and the gate would fire on a comment
 * three lines above an edit.
 */
export function parseDiff(diff: string, root: string): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  let current: string | undefined;
  for (const line of diff.split('\n')) {
    const target = TARGET_FILE.exec(line);
    if (target) {
      const file = target[1];
      // /dev/null is a deletion; it has no lines to attribute.
      current = file === undefined || file === '/dev/null' ? undefined : path.resolve(root, file);
      continue;
    }
    if (current === undefined) continue;
    const hunk = HUNK.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    // A missing count means one line; an explicit 0 means the hunk only
    // deletes, and a deletion introduces no line to report a finding on.
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    let set = lines.get(current);
    if (!set) {
      set = new Set();
      lines.set(current, set);
    }
    for (let n = start; n < start + count; n += 1) set.add(n - 1);
  }
  return lines;
}

/**
 * What `git commit` is about to commit: the staged diff, as files plus
 * the lines they gained.
 *
 * Deliberately reads the index (`--cached`) for the line map while the
 * tools read the working tree, which is the one place those two can
 * disagree — a partially staged file is analyzed as it sits on disk but
 * attributed by what was staged. The alternative, stashing the unstaged
 * remainder around every check, costs a working-tree rewrite on every
 * commit and fails badly when interrupted.
 */
export function stagedChanges(cwd: string): ChangeSet | undefined {
  const root = repoRoot(cwd);
  if (root === undefined) return undefined;
  // ACMR drops deletions: a file that no longer exists has no findings.
  const names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], root);
  if (names === undefined) return undefined;
  const files = names
    .split('\0')
    .filter((name) => name !== '')
    .map((name) => path.resolve(root, name));

  const diff = git(['diff', '--cached', '--unified=0', '--diff-filter=ACMR'], root);
  return diff === undefined ? { files } : { files, lines: parseDiff(diff, root) };
}

/**
 * Everything on this branch that the upstream does not have. Falls back
 * to the whole diff against the merge base with the default branch, and
 * then to nothing — a push with no upstream is the first push of a
 * branch, where "changed" has no useful meaning and the suite's own
 * novelty policy should decide.
 */
export function branchChanges(cwd: string): ChangeSet | undefined {
  const root = repoRoot(cwd);
  if (root === undefined) return undefined;
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd)?.trim();
  if (!upstream) return undefined;
  const names = git(['diff', '--name-only', '--diff-filter=ACMR', '-z', `${upstream}...HEAD`], root);
  if (names === undefined) return undefined;
  const files = names
    .split('\0')
    .filter((name) => name !== '')
    .map((name) => path.resolve(root, name));
  const diff = git(['diff', '--unified=0', '--diff-filter=ACMR', `${upstream}...HEAD`], root);
  return diff === undefined ? { files } : { files, lines: parseDiff(diff, root) };
}
