import { filterFindings, isFindingArray } from '../config/index.js';
import type { Finding } from '../tool/index.js';
import type { Baseline } from './baseline.js';
import type { ChangeSet } from './changes.js';
import { applyNovelty } from './novelty.js';
import { activeTools, type CheckLevel, type CheckSuite, type Novelty } from './suites.js';

/**
 * Running a whole suite against one project. The point of doing it here
 * rather than in a shell loop over the CLI is the session: dispatch
 * caches one project session per root, so the suite pays language
 * server startup and the initial typecheck once instead of once per
 * tool. Against this repository that is 5.9s of five separate processes
 * against 0.93s of one — 440ms for the first tool and 48-322ms for each
 * one after. A gate nobody waits six seconds for is a gate that gets
 * uninstalled.
 */

/** What the check runner needs of a dispatch layer — the ferry, in practice. */
export interface Dispatcher {
  call(toolName: string, projectRoot: string, input: unknown): Promise<unknown>;
}

export interface CheckRunInput {
  suite: CheckSuite;
  rootPath: string;
  dispatcher: Dispatcher;
  changes?: ChangeSet | undefined;
  baseline?: Baseline | undefined;
}

export interface ToolOutcome {
  tool: string;
  level: CheckLevel;
  findings: Finding[];
}

export interface CheckReport {
  /** Findings from `block` tools: non-empty means the gate rejects. */
  blocking: Finding[];
  /** Findings from `warn` tools: reported, never rejected. */
  advisory: Finding[];
  outcomes: ToolOutcome[];
  /** The novelty policy actually applied, which may be broader. */
  novelty: Novelty;
  note?: string;
}

/**
 * A suite narrowed to changed files reports on them and no more, which
 * is also what lets a docs-only commit cost nothing: dispatch answers a
 * scope naming no source file without opening a session at all.
 * Baseline and whole-project suites pass no scope, because the finding
 * they exist to catch is frequently in a file the change never touched.
 */
function scopeFor(suite: CheckSuite, changes: ChangeSet | undefined): string[] | undefined {
  if (suite.novelty === 'baseline' || suite.novelty === 'none') return undefined;
  return changes?.files;
}

export async function runSuite(input: CheckRunInput): Promise<CheckReport> {
  const { suite, rootPath, dispatcher, changes, baseline } = input;
  const files = scopeFor(suite, changes);

  const outcomes: ToolOutcome[] = [];
  for (const { name, entry } of activeTools(suite)) {
    const toolInput: Record<string, unknown> = { ...entry.config?.input };
    if (files !== undefined) toolInput['files'] = files;

    const result = await dispatcher.call(name, rootPath, toolInput);
    if (!isFindingArray(result)) continue;
    // The suite's own tuning layers on top of whatever static-x.json
    // already applied for this tool, so a gate can be stricter than the
    // tool's everyday settings without changing them everywhere.
    const findings = entry.config ? filterFindings(result, entry.config) : result;
    outcomes.push({ tool: name, level: entry.level, findings });
  }

  const all = outcomes.flatMap((outcome) => outcome.findings);
  const novelty = applyNovelty(all, { novelty: suite.novelty, rootPath, changes, baseline });
  const kept = new Set(novelty.kept);

  const surviving = outcomes.map((outcome) => ({
    ...outcome,
    findings: outcome.findings.filter((finding) => kept.has(finding)),
  }));

  return {
    blocking: surviving.filter((o) => o.level === 'block').flatMap((o) => o.findings),
    advisory: surviving.filter((o) => o.level === 'warn').flatMap((o) => o.findings),
    outcomes: surviving,
    novelty: novelty.applied,
    ...(novelty.note === undefined ? {} : { note: novelty.note }),
  };
}
