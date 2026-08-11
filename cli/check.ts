import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  activeTools,
  branchChanges,
  loadBaseline,
  resolveSuite,
  runSuite,
  stagedChanges,
  suiteNames,
  writeBaseline,
  type ChangeSet,
  type CheckReport,
  type CheckSuite,
} from '../core/checks/index.js';
import { loadProjectConfig } from '../core/config/index.js';
import type { Finding } from '../core/tool/index.js';
import { TsFerry } from '../ts/ferry/ferry.js';
import { TS_DEFAULT_CHECKS } from '../ts/checks.js';
import { createTsRegistry } from '../ts/registry.js';
import { findingLine } from './format.js';
import type { CliIo } from './io.js';

/**
 * `static-x check <suite>` — one process, every tool in the suite, one
 * project session. This is the command a hook runs, and running the
 * whole suite in one invocation is most of why installing one is worth
 * it: five tools over five CLI processes takes 5.9s against this
 * repository, and over one takes 0.93s.
 *
 * Exit codes follow the CLI's: 0 clean (advisory findings included), 1
 * blocked, 2 could not run. `--from claude` overrides that with Claude
 * Code's own contract, which is the whole reason its hook used to need
 * a wrapper script.
 */

export const CHECK_USAGE = [
  'Usage: static-x check <suite> [--project <root>] [--from <source>] [--format json|text]',
  '       static-x check --list [--project <root>]',
  '',
  '  --from  Where the changed-file and changed-line information comes from:',
  '          auto (default)  git-staged for a per-file suite, project otherwise',
  '          git-staged      what `git commit` is about to commit',
  '          git-branch      everything this branch has that its upstream does not',
  '          claude          a Claude Code hook event on stdin; exit codes become',
  '                          Claude\'s (2 blocks and feeds stderr back to the model)',
  '          project         the whole project, with no change information',
];

export const BASELINE_USAGE = [
  'Usage: static-x baseline [<suite>] [--project <root>]',
  '',
  '  Records what the suite reports now, so later runs report only what came',
  '  after. Rewrites the file from scratch: an entry that no longer reproduces',
  '  disappears rather than lingering. Defaults to the `push` suite.',
];

type ChangeSource = 'auto' | 'git-staged' | 'git-branch' | 'claude' | 'project';

const SOURCES = new Set<string>(['auto', 'git-staged', 'git-branch', 'claude', 'project']);
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

interface ClaudeEvent {
  cwd?: string;
  tool_input?: { file_path?: string };
}

async function readStdin(io: CliIo): Promise<string> {
  if (io.readStdin) return io.readStdin();
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += chunk as string;
  return text;
}

/**
 * The change a Claude Code PostToolUse event describes: the one file
 * the model just wrote. Whole-file rather than line-scoped on purpose —
 * a model that rewrites a file wholesale leaves hunks that say nothing
 * useful about which lines are its own.
 */
async function claudeChanges(
  io: CliIo,
): Promise<{ changes?: ChangeSet; project?: string; skip: boolean }> {
  let event: ClaudeEvent | undefined;
  try {
    event = JSON.parse(await readStdin(io)) as ClaudeEvent;
  } catch {
    return { skip: true };
  }
  const file = event.tool_input?.file_path;
  if (typeof file !== 'string' || !SOURCE_FILE.test(file)) return { skip: true };
  // CLAUDE_PROJECT_DIR is exported into every hook process; the event's
  // cwd covers a hook run outside a project directory.
  const project = process.env['CLAUDE_PROJECT_DIR'] ?? event.cwd;
  return {
    changes: { files: [path.resolve(file)] },
    ...(project === undefined ? {} : { project }),
    skip: false,
  };
}

function gatherChanges(source: ChangeSource, suite: CheckSuite, cwd: string): ChangeSet | undefined {
  const resolved =
    source !== 'auto'
      ? source
      : suite.novelty === 'changed-lines' || suite.novelty === 'changed-file'
        ? 'git-staged'
        : 'project';
  if (resolved === 'git-staged') return stagedChanges(cwd);
  if (resolved === 'git-branch') return branchChanges(cwd);
  return undefined;
}

function reportLines(report: CheckReport, suite: string, cwd: string): string[] {
  const lines: string[] = [];
  if (report.blocking.length > 0) {
    lines.push(`Blocking (${String(report.blocking.length)}):`);
    for (const finding of report.blocking) lines.push(`  ${findingLine(finding, cwd)}`);
  }
  if (report.advisory.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Advisory (${String(report.advisory.length)}) — reported, not blocking:`);
    for (const finding of report.advisory) lines.push(`  ${findingLine(finding, cwd)}`);
  }
  if (lines.length > 0) {
    lines.push('');
    lines.push(`${suite}: reporting ${report.novelty}`);
  }
  // A degraded policy is printed even on a clean run: a gate that
  // quietly stopped filtering looks exactly like one that found
  // something real, and the difference matters the next time it fires.
  if (report.note !== undefined) lines.push(`${suite}: ${report.note}`);
  return lines;
}

function listSuites(
  config: Awaited<ReturnType<typeof loadProjectConfig>>,
  registry: ReturnType<typeof createTsRegistry>,
  io: CliIo,
): number {
  for (const name of suiteNames(config, TS_DEFAULT_CHECKS)) {
    let suite: CheckSuite;
    try {
      suite = resolveSuite(name, config, TS_DEFAULT_CHECKS, registry);
    } catch (error) {
      io.err(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    io.out(`${name} (${suite.novelty})`);
    for (const { name: tool, entry } of activeTools(suite)) {
      const tuning = entry.config
        ? ` [${Object.entries(entry.config)
            .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
            .join(' ')}]`
        : '';
      io.out(`  ${entry.level.padEnd(5)} ${tool}${tuning}`);
    }
  }
  return 0;
}

export async function runCheck(argv: string[], io: CliIo): Promise<number> {
  let values: { project?: string; from?: string; format?: string; list?: boolean };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        from: { type: 'string' },
        format: { type: 'string' },
        list: { type: 'boolean' },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    io.err(String(error instanceof Error ? error.message : error));
    return 2;
  }

  const source = (values.from ?? 'auto') as ChangeSource;
  if (!SOURCES.has(source)) {
    io.err(`--from must be one of ${[...SOURCES].join(', ')} (got ${source})`);
    return 2;
  }
  const format = values.format ?? 'text';
  if (format !== 'json' && format !== 'text') {
    io.err(`--format must be json or text (got ${format})`);
    return 2;
  }

  // Claude's contract, established before anything can fail: a hook that
  // wedges the session is worse than no hook, so every error below this
  // point exits 0 when the event came from Claude.
  const forClaude = source === 'claude';
  const bail = (message: string): number => {
    io.err(message);
    return forClaude ? 0 : 2;
  };

  let changes: ChangeSet | undefined;
  let projectFromEvent: string | undefined;
  if (forClaude) {
    const event = await claudeChanges(io);
    if (event.skip) return 0;
    changes = event.changes;
    projectFromEvent = event.project;
  }

  const cwd = io.cwd ?? process.cwd();
  const project = values.project ?? projectFromEvent ?? cwd;
  const registry = createTsRegistry();

  let config;
  try {
    config = await loadProjectConfig(path.resolve(project));
  } catch (error) {
    return bail(error instanceof Error ? error.message : String(error));
  }

  if (values.list) return listSuites(config, registry, io);

  const [suiteName] = positionals;
  if (suiteName === undefined) {
    for (const line of CHECK_USAGE) io.err(line);
    io.err(`Suites: ${suiteNames(config, TS_DEFAULT_CHECKS).join(', ')}`);
    return forClaude ? 0 : 2;
  }

  let suite: CheckSuite;
  try {
    suite = resolveSuite(suiteName, config, TS_DEFAULT_CHECKS, registry);
  } catch (error) {
    return bail(error instanceof Error ? error.message : String(error));
  }

  if (!forClaude) changes = gatherChanges(source, suite, cwd);

  // Nothing changed that could carry a finding: answer before opening a
  // session, so a docs-only commit pays nothing at all.
  if (changes && changes.files.length === 0 && suite.novelty !== 'baseline' && suite.novelty !== 'none') {
    if (format === 'json') io.out(JSON.stringify({ suite: suiteName, blocking: [], advisory: [] }, null, 2));
    return 0;
  }

  const ferry = new TsFerry(registry);
  try {
    const rootPath = path.resolve(project);
    const baseline = suite.novelty === 'baseline' ? await loadBaseline(rootPath) : undefined;
    const report = await runSuite({ suite, rootPath, dispatcher: ferry, changes, baseline });

    if (format === 'json') {
      io.out(JSON.stringify({ suite: suiteName, ...report }, null, 2));
    } else {
      // Claude reads stderr; a human reads stdout. Blocking findings go
      // to stderr either way — they are the reason the gate rejected.
      const toStderr = forClaude || report.blocking.length > 0;
      for (const line of reportLines(report, suiteName, cwd)) {
        if (toStderr) io.err(line);
        else io.out(line);
      }
    }

    if (report.blocking.length === 0) return 0;
    if (forClaude) {
      io.err('');
      io.err('Fix these in the file you just wrote before moving on.');
      return 2;
    }
    return 1;
  } catch (error) {
    return bail(error instanceof Error ? error.message : String(error));
  } finally {
    await ferry.dispose();
  }
}

export async function runBaselineCommand(argv: string[], io: CliIo): Promise<number> {
  let values: { project?: string };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { project: { type: 'string' } },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    io.err(String(error instanceof Error ? error.message : error));
    return 2;
  }

  const project = values.project ?? io.cwd ?? process.cwd();
  const rootPath = path.resolve(project);
  const registry = createTsRegistry();
  const suiteName = positionals[0] ?? 'push';

  let suite: CheckSuite;
  let config;
  try {
    config = await loadProjectConfig(rootPath);
    suite = resolveSuite(suiteName, config, TS_DEFAULT_CHECKS, registry);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const ferry = new TsFerry(registry);
  try {
    // Recorded unfiltered by novelty: the baseline is the "before" that
    // novelty is measured against, so filtering it against itself would
    // record nothing.
    const report = await runSuite({ suite, rootPath, dispatcher: ferry });
    const findings: Finding[] = [...report.blocking, ...report.advisory];
    const written = await writeBaseline(rootPath, findings);
    io.out(
      `Recorded ${String(written.entries)} baseline ${written.entries === 1 ? 'entry' : 'entries'} ` +
        `from ${String(findings.length)} findings in ${path.relative(io.cwd ?? process.cwd(), written.file) || written.file}`,
    );
    io.out('Commit it: later runs of this suite report only what came after.');

    // Naming what was accepted at block level, because that is the one
    // thing recording a baseline does that nobody asked for: these would
    // have rejected a push, and now they will not. Silence here turns a
    // baseline into a way to lose a real finding by running one command.
    if (report.blocking.length > 0) {
      io.out('');
      io.out(
        `${String(report.blocking.length)} of those would otherwise block this suite, and no ` +
          'longer will:',
      );
      for (const finding of report.blocking) io.out(`  ${findingLine(finding, io.cwd ?? process.cwd())}`);
    }
    return 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    await ferry.dispose();
  }
}
