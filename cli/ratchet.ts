import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  baselinePath,
  isEmptyPlan,
  loadBaseline,
  planRatchet,
  resolveSuite,
  runSuite,
  serializeSuite,
  suiteNames,
  tally,
  writeBaseline,
  type CheckSuite,
  type RatchetPlan,
} from '../core/checks/index.js';
import { CONFIG_FILENAME, loadProjectConfig } from '../core/config/index.js';
import type { Finding } from '../core/tool/index.js';
import { PackRouter } from '../core/pack/index.js';
import { createPacks } from '../packs/index.js';
import { isHelpFlag } from './usage.js';
import type { CliIo } from './io.js';

/**
 * `static-x ratchet` — tighten every gate as far as the project's own
 * findings allow, and no further.
 *
 * Dry-run by default, like every mutating tool here: it rewrites
 * static-x.json and the baseline, and both are files someone has to live
 * with afterwards.
 *
 * It is deliberately not a hook and not a CI step. A ratchet that runs
 * automatically locks in whatever strictness one machine reached on a
 * good day, and the next person to push is blocked by someone else's
 * luck. Run it when you want to bank progress.
 */

export const RATCHET_USAGE = [
  'Usage: static-x ratchet [<suite>] [--project <root>] [--apply]',
  '',
  '  Tightens what the project has already earned: shrinks the baseline to what',
  '  still reproduces, promotes a `warn` tool to `block` once it reports nothing,',
  '  and retires the baseline policy entirely once the baseline empties.',
  '',
  '  Refuses to do anything while a finding has regressed. Accepting one is what',
  '  `static-x baseline` is for, and it should take saying so out loud.',
  '',
  '  With no suite named, every suite is considered. --apply writes the changes.',
];

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function describe(plan: RatchetPlan, io: CliIo, cwd: string, root: string): void {
  const head = `${plan.suite}:`;
  if (plan.blocked !== undefined) {
    io.err(`${head} ${plan.blocked}`);
    for (const entry of plan.delta?.regressed ?? []) {
      io.err(`  ${entry.key}  ${String(entry.before)} → ${String(entry.after)}`);
    }
    return;
  }
  if (isEmptyPlan(plan)) {
    io.out(`${head} nothing to tighten`);
    return;
  }

  if (plan.delta && plan.delta.resolved.length > 0) {
    const { before, after, resolved } = plan.delta;
    io.out(
      `${head} baseline ${String(before)} → ${String(after)} ` +
        `(${plural(resolved.length, 'entry', 'entries')} resolved)`,
    );
    for (const entry of resolved) {
      const gone = entry.after === 0 ? 'gone' : `${String(entry.before)} → ${String(entry.after)}`;
      io.out(`  ${entry.key}  ${gone}`);
    }
  }
  for (const promotion of plan.promotions) {
    io.out(`${head} ${promotion.tool}  warn → block  (${promotion.reason})`);
  }
  if (plan.novelty) {
    io.out(`${head} novelty ${plan.novelty.from} → ${plan.novelty.to}`);
  }
  if (plan.retireBaseline) {
    io.out(`${head} retire ${path.relative(cwd, baselinePath(root)) || baselinePath(root)}`);
  }
}

/** The suite as it should read after the plan is applied. */
function tightened(suite: CheckSuite, plan: RatchetPlan): CheckSuite {
  const tools = { ...suite.tools };
  for (const promotion of plan.promotions) {
    const entry = tools[promotion.tool];
    if (entry) tools[promotion.tool] = { ...entry, level: promotion.to };
  }
  return { novelty: plan.novelty?.to ?? suite.novelty, tools };
}

/**
 * Writes the tightened suites back. A project relying on the defaults
 * has no `checks` block to edit, so the first ratchet materializes every
 * suite — the same thing `install` does, and for the same reason: a gate
 * that changed under you is worse than one you can read.
 */
async function writeConfig(
  root: string,
  suites: Map<string, CheckSuite>,
  router: PackRouter,
  config: Record<string, unknown> | undefined,
): Promise<void> {
  const { registry } = router;
  const defaults = router.defaultChecks();
  const file = path.join(root, CONFIG_FILENAME);
  const existing: Record<string, unknown> = config ? { ...config } : {};
  const checks: Record<string, unknown> = {};
  for (const name of suiteNames(config, defaults)) {
    const suite = suites.get(name) ?? resolveSuite(name, config, defaults, registry);
    checks[name] = serializeSuite(suite);
  }
  await writeFile(file, `${JSON.stringify({ ...existing, checks }, null, 2)}\n`, 'utf8');
}

export async function runRatchet(argv: string[], io: CliIo): Promise<number> {
  if (argv.some(isHelpFlag)) {
    for (const line of RATCHET_USAGE) io.out(line);
    return 0;
  }
  let values: { project?: string; apply?: boolean };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { project: { type: 'string' }, apply: { type: 'boolean' } },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    io.err(String(error instanceof Error ? error.message : error));
    for (const line of RATCHET_USAGE) io.err(line);
    return 2;
  }

  const cwd = io.cwd ?? process.cwd();
  const root = path.resolve(values.project ?? cwd);
  const apply = values.apply ?? false;
  const router = new PackRouter(createPacks());
  const registry = router.registry;
  const defaults = router.defaultChecks();

  let config;
  try {
    config = await loadProjectConfig(root);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const names = positionals.length > 0 ? positionals : suiteNames(config, defaults);
  const ferry = router;
  const plans: RatchetPlan[] = [];
  const tightenedSuites = new Map<string, CheckSuite>();
  let retire = false;

  try {
    const baseline = await loadBaseline(root);
    for (const suiteName of names) {
      const suite = resolveSuite(suiteName, config, defaults, registry);
      // Unfiltered, whole project: the only view a ratchet can reason
      // from. One commit's worth of evidence is not grounds to tighten.
      const report = await runSuite({ suite, rootPath: root, dispatcher: ferry });
      const findings: Finding[] = [...report.blocking, ...report.advisory];
      const plan = planRatchet({
        suiteName,
        suite,
        outcomes: report.outcomes,
        current: tally(findings, root),
        baseline,
      });
      plans.push(plan);
      if (plan.blocked === undefined && !isEmptyPlan(plan)) {
        tightenedSuites.set(suiteName, tightened(suite, plan));
        if (plan.retireBaseline) retire = true;
      }
      if (plan.delta && plan.delta.regressed.length === 0 && apply && plan.delta.resolved.length > 0) {
        await writeBaseline(root, findings);
      }
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    await ferry.dispose();
  }

  for (const plan of plans) describe(plan, io, cwd, root);

  const blocked = plans.some((plan) => plan.blocked !== undefined);
  if (tightenedSuites.size === 0) return blocked ? 1 : 0;

  if (!apply) {
    io.out('');
    io.out('Dry run — pass --apply to write these.');
    return blocked ? 1 : 0;
  }

  try {
    await writeConfig(root, tightenedSuites, router, config);
    io.out('');
    io.out(`Updated ${path.relative(cwd, path.join(root, CONFIG_FILENAME)) || CONFIG_FILENAME}`);
    if (retire) {
      await rm(baselinePath(root), { force: true });
      io.out(`Removed ${path.relative(cwd, baselinePath(root))} — the suite reports on everything now`);
    } else if (plans.some((plan) => (plan.delta?.resolved.length ?? 0) > 0)) {
      io.out(`Updated ${path.relative(cwd, baselinePath(root))}`);
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
  return blocked ? 1 : 0;
}
