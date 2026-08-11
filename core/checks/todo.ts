import path from 'node:path';
import type { Finding } from '../tool/index.js';
import { fingerprint, type Baseline } from './baseline.js';

/**
 * The backlog a baseline is hiding, turned back into a work queue.
 *
 * Recording a baseline makes a gate installable by declaring everything
 * it found to be somebody else's problem — after which `check` reports
 * nothing and the findings are invisible. That is correct for a hook and
 * useless for anyone actually working the list down. `todo` asks the
 * opposite question: not "what is new" but "what did we agree to ignore,
 * and where is it".
 *
 * The filter is the important part. Most findings state a fact; only
 * some of them imply a safe edit, and an agent working unattended has to
 * be held to the second set. See the language pack's fixable-code list
 * for which and why.
 */

interface TodoItem {
  finding: Finding;
  /** Project-relative, for stable grouping and display. */
  file: string;
}

export interface TodoList {
  /** Actionable items, grouped by file so one edit can clear several. */
  files: { file: string; items: TodoItem[] }[];
  /** How many actionable items in total. */
  count: number;
  /** Everything in the baseline, actionable or not. */
  backlog: number;
  /** Code to count, for findings held back as not safely fixable. */
  excluded: Map<string, number>;
}

interface TodoInput {
  findings: readonly Finding[];
  baseline: Baseline;
  rootPath: string;
  /** Finding codes an agent may act on. */
  fixable: ReadonlySet<string>;
  /** Restrict further to these codes, when the caller names some. */
  only?: ReadonlySet<string> | undefined;
}

/**
 * A finding belongs to the backlog when the baseline already accounts
 * for it. Anything else is a regression, which `check` reports and
 * `ratchet` refuses — neither is this command's business, and mixing
 * them would let an agent "work the backlog" by fixing damage it had
 * just done.
 */
export function planTodo(input: TodoInput): TodoList {
  const { findings, baseline, rootPath, fixable, only } = input;

  const remaining = new Map(baseline);
  const backlog: Finding[] = [];
  for (const finding of findings) {
    const key = fingerprint(finding, rootPath);
    const budget = remaining.get(key) ?? 0;
    if (budget > 0) {
      remaining.set(key, budget - 1);
      backlog.push(finding);
    }
  }

  const excluded = new Map<string, number>();
  const actionable: TodoItem[] = [];
  for (const finding of backlog) {
    if (!fixable.has(finding.code) || (only && !only.has(finding.code))) {
      excluded.set(finding.code, (excluded.get(finding.code) ?? 0) + 1);
      continue;
    }
    actionable.push({
      finding,
      file: path.relative(rootPath, finding.file) || path.basename(finding.file),
    });
  }

  const grouped = new Map<string, TodoItem[]>();
  for (const item of actionable) {
    const list = grouped.get(item.file);
    if (list) list.push(item);
    else grouped.set(item.file, [item]);
  }

  // Most findings first: a file with six is one edit and one test run,
  // which is the cheapest unit of progress the loop can make.
  const files = [...grouped]
    .map(([file, items]) => ({
      file,
      items: items.sort((a, b) => a.finding.range.start.line - b.finding.range.start.line),
    }))
    .sort((a, b) => b.items.length - a.items.length || (a.file < b.file ? -1 : 1));

  return { files, count: actionable.length, backlog: backlog.length, excluded };
}
