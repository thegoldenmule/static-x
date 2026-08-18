import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  loadBaseline,
  planTodo,
  resolveSuite,
  runSuite,
  type CheckSuite,
  type TodoList,
} from '../core/checks/index.js';
import { loadProjectConfig, type ProjectConfig } from '../core/config/index.js';
import { PackRouter } from '../core/pack/index.js';
import { createPacks } from '../packs/index.js';
import { findingLine } from './format.js';
import { isHelpFlag } from './usage.js';
import type { CliIo } from './io.js';

/**
 * `static-x todo` — what the baseline is hiding, as a work queue.
 *
 * This is the other half of `baseline`. Recording one makes a gate
 * installable by declaring everything it found to be somebody else's
 * problem, after which `check` reports nothing and the backlog is
 * invisible. Useful for a hook; useless for anyone working the list
 * down, and impossible for an agent, which cannot fix what it cannot
 * enumerate.
 *
 * The default list is narrowed to codes whose fix a typecheck and a test
 * run can actually vouch for — each pack’s fixableCodes says which and why.
 * `--all` shows the whole backlog, for a human deciding what to do next.
 */

export const TODO_USAGE = [
  'Usage: static-x todo [<suite>] [--project <root>] [--format text|json]',
  '                     [--code <finding-code>]... [--limit <n>] [--all]',
  '',
  '  Lists the findings the baseline accounts for, grouped by file, most first.',
  '  Restricted by default to codes an agent can fix under a typecheck and a',
  '  test run; --all drops that restriction. Defaults to the `push` suite.',
  '',
  '  Exit 0 with an empty queue means the backlog is clear — ratchet can retire',
  '  the baseline. Exit 1 means there is work.',
];

function textLines(todo: TodoList, suite: string, cwd: string, rootPath: string): string[] {
  const lines: string[] = [];
  for (const { file, items } of todo.files) {
    lines.push(`${file}  (${String(items.length)})`);
    for (const item of items) lines.push(`  ${findingLine(item.finding, cwd)}`);
    lines.push('');
  }
  if (todo.count === 0) {
    lines.push(
      todo.backlog === 0
        ? `${suite}: baseline is empty — \`static-x ratchet --apply\` can retire it`
        : `${suite}: nothing actionable (${String(todo.backlog)} in the backlog, all held back)`,
    );
  } else {
    lines.push(
      `${suite}: ${String(todo.count)} actionable in ${String(todo.files.length)} ` +
        `${todo.files.length === 1 ? 'file' : 'files'}, of ${String(todo.backlog)} in the backlog`,
    );
  }
  if (todo.excluded.size > 0) {
    const held = [...todo.excluded]
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => `${code} ${String(n)}`)
      .join(', ');
    lines.push(`held back: ${held}`);
  }
  // The baseline lives beside the project, not the caller; naming it
  // saves an agent guessing where the queue is recorded.
  lines.push(`baseline: ${path.relative(cwd, path.join(rootPath, 'static-x-baseline.json')) || 'static-x-baseline.json'}`);
  return lines;
}

function fixableFor(
  config: ProjectConfig | undefined,
  packDefault: ReadonlySet<string>,
): ReadonlySet<string> {
  const todo = config?.['todo'];
  if (todo === null || typeof todo !== 'object' || Array.isArray(todo)) return packDefault;
  const codes = (todo as Record<string, unknown>)['codes'];
  if (!Array.isArray(codes)) return packDefault;
  return new Set(codes.filter((code): code is string => typeof code === 'string'));
}

export async function runTodo(argv: string[], io: CliIo): Promise<number> {
  if (argv.some(isHelpFlag)) {
    for (const line of TODO_USAGE) io.out(line);
    return 0;
  }

  let values: { project?: string; format?: string; code?: string[]; limit?: string; all?: boolean };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        format: { type: 'string' },
        code: { type: 'string', multiple: true },
        limit: { type: 'string' },
        all: { type: 'boolean' },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    io.err(String(error instanceof Error ? error.message : error));
    for (const line of TODO_USAGE) io.err(line);
    return 2;
  }

  const format = values.format ?? 'text';
  if (format !== 'json' && format !== 'text') {
    io.err(`--format must be json or text (got ${format})`);
    return 2;
  }
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    io.err(`--limit must be a positive integer (got ${values.limit ?? ''})`);
    return 2;
  }

  const cwd = io.cwd ?? process.cwd();
  const rootPath = path.resolve(values.project ?? cwd);
  const suiteName = positionals[0] ?? 'push';
  const router = new PackRouter(createPacks());
  const registry = router.registry;
  const defaults = router.defaultChecks();

  let config;
  let suite: CheckSuite;
  try {
    config = await loadProjectConfig(rootPath);
    suite = resolveSuite(suiteName, config, defaults, registry);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const baseline = await loadBaseline(rootPath);
  if (!baseline) {
    io.err(`${suiteName}: no baseline recorded — run \`static-x baseline ${suiteName}\` first`);
    return 2;
  }

  const ferry = router;
  let todo: TodoList;
  try {
    // Unfiltered: novelty would hide precisely what we are asking for.
    const report = await runSuite({ suite, rootPath, dispatcher: ferry });
    const codes = report.outcomes.flatMap((o) => o.findings.map((f) => f.code));
    todo = planTodo({
      outcomes: report.outcomes,
      baseline,
      rootPath,
      fixable: values.all ? new Set(codes) : fixableFor(config, router.fixableCodes()),
      ...(values.code ? { only: new Set(values.code) } : {}),
    });
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    await ferry.dispose();
  }

  if (limit !== undefined) {
    const files: TodoList['files'] = [];
    let taken = 0;
    for (const group of todo.files) {
      if (taken >= limit) break;
      const items = group.items.slice(0, limit - taken);
      files.push({ file: group.file, items });
      taken += items.length;
    }
    todo = { ...todo, files, count: taken };
  }

  if (format === 'json') {
    io.out(
      JSON.stringify(
        {
          suite: suiteName,
          count: todo.count,
          backlog: todo.backlog,
          files: todo.files,
          excluded: Object.fromEntries(todo.excluded),
        },
        null,
        2,
      ),
    );
  } else {
    for (const line of textLines(todo, suiteName, cwd, rootPath)) io.out(line);
  }
  return todo.count > 0 ? 1 : 0;
}
