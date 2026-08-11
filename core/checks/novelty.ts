import path from 'node:path';
import type { Finding } from '../tool/index.js';
import { notInBaseline, type Baseline } from './baseline.js';
import type { ChangeSet } from './changes.js';
import type { Novelty } from './suites.js';

/**
 * Narrowing a suite's findings to the ones the change is answerable
 * for. This is what decides whether a hook is installable: run the
 * three-tool commit suite unfiltered against this repository and 79 of
 * 141 source files carry a finding, so the first commit to touch any of
 * them is rejected over code its author never wrote — and the hook is
 * uninstalled the same afternoon.
 */

export interface NoveltyInput {
  novelty: Novelty;
  rootPath: string;
  changes?: ChangeSet | undefined;
  baseline?: Baseline | undefined;
}

export interface NoveltyResult {
  kept: Finding[];
  /** What was actually applied, which may be broader than requested. */
  applied: Novelty;
  /** Why, when the requested policy could not be. */
  note?: string;
}

/** Does the finding cover any line the change introduced? */
function touchesChangedLine(finding: Finding, lines: ReadonlyMap<string, ReadonlySet<number>>) {
  const changed = lines.get(path.resolve(finding.file));
  if (!changed) return false;
  for (let line = finding.range.start.line; line <= finding.range.end.line; line += 1) {
    if (changed.has(line)) return true;
  }
  return false;
}

/**
 * A policy the event cannot supply the inputs for degrades to the next
 * broader one and says so, rather than failing or silently widening.
 * Silence is the dangerous option: a gate that quietly stopped
 * filtering looks exactly like a gate that found something real.
 */
export function applyNovelty(findings: readonly Finding[], input: NoveltyInput): NoveltyResult {
  const { novelty, rootPath, changes, baseline } = input;

  if (novelty === 'changed-lines') {
    if (changes?.lines) {
      const lines = changes.lines;
      return { kept: findings.filter((f) => touchesChangedLine(f, lines)), applied: 'changed-lines' };
    }
    return {
      ...applyNovelty(findings, { ...input, novelty: 'changed-file' }),
      note: 'no line-level diff available; reporting every finding in the changed files',
    };
  }

  if (novelty === 'changed-file') {
    if (changes?.files) {
      // The ferry already scoped reporting to these files; this pass is
      // what makes the policy hold when a suite is run without one.
      const files = new Set(changes.files.map((file) => path.resolve(file)));
      return { kept: findings.filter((f) => files.has(path.resolve(f.file))), applied: 'changed-file' };
    }
    return {
      kept: [...findings],
      applied: 'none',
      note: 'no changed-file list available; reporting on the whole project',
    };
  }

  if (novelty === 'baseline') {
    if (baseline) return { kept: notInBaseline(findings, baseline, rootPath), applied: 'baseline' };
    return {
      kept: [...findings],
      applied: 'none',
      note: 'no baseline recorded; run `static-x baseline` to record one',
    };
  }

  return { kept: [...findings], applied: 'none' };
}
