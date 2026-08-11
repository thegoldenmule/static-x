import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG_FILENAME } from '../core/config/index.js';
import type { CheckSuite } from '../core/checks/index.js';
import { TS_DEFAULT_CHECKS } from '../ts/checks.js';
import type { CliIo } from './run.js';

/**
 * `static-x install` — write the hooks, merge the settings, and put the
 * default suites into static-x.json where they can be read and edited.
 *
 * The scripts it writes hold no policy. They locate the binary, run one
 * `static-x check <suite>`, and stop; the gate itself lives in
 * static-x.json, so changing what the hook enforces never means editing
 * a shell script or remembering which environment variable configured
 * it. That is the whole point: a hook you have to edit is a hook nobody
 * keeps current.
 */

export const INSTALL_USAGE = [
  'Usage: static-x install [--project <root>] [--target git|claude|config]... [--force] [--dry-run]',
  '',
  '  Writes a pre-commit and pre-push hook (husky if the project uses it),',
  '  registers the Claude Code PostToolUse hook, and materializes the default',
  '  check suites into static-x.json. Targets default to all three.',
  '',
  '  --force    Overwrite hooks this command did not write.',
  '  --dry-run  Print what would change without writing anything.',
];

/**
 * How the installer recognizes its own work, so a second run updates a
 * hook it wrote and refuses to touch one it did not. The strings have
 * to appear verbatim in what gets written: the shell script never says
 * "static-x check" literally — it resolves the binary into `$bin`
 * first — so matching on that would make the installer a stranger to
 * every hook it had already placed.
 */
const HOOK_MARKER = 'Installed by `static-x install`';
const CLAUDE_MARKER = 'static-x check claude';

/**
 * Finding the binary is the hook's job, not the installer's: a hook
 * hard-coding an absolute path breaks for the next person to clone the
 * repository, and one that assumes PATH breaks under git GUIs, which
 * frequently run hooks with a login shell's PATH missing.
 */
function hookScript(suite: string, from: string): string {
  return `#!/bin/sh
# ${HOOK_MARKER}. The gate is configured in ${CONFIG_FILENAME},
# not here — edit checks.${suite} there to change what this enforces.
if command -v static-x >/dev/null 2>&1; then
  bin=static-x
elif [ -x node_modules/.bin/static-x ]; then
  bin=node_modules/.bin/static-x
else
  echo "static-x not found — skipping checks" >&2
  exit 0
fi
exec "$bin" check ${suite} --from ${from}
`;
}

const CLAUDE_HOOK_COMMAND =
  'static-x check claude --from claude --project "${CLAUDE_PROJECT_DIR}"';

interface Change {
  file: string;
  note: string;
  write?: () => Promise<void>;
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file}: top level must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Husky owns .husky/ when it exists; otherwise git's own hooks path. */
function hookDirectory(root: string): { dir: string; husky: boolean } | undefined {
  if (existsSync(path.join(root, '.husky'))) return { dir: path.join(root, '.husky'), husky: true };
  if (existsSync(path.join(root, '.git'))) return { dir: path.join(root, '.git/hooks'), husky: false };
  return undefined;
}

async function gitChanges(root: string, force: boolean, io: CliIo): Promise<Change[]> {
  const target = hookDirectory(root);
  if (!target) {
    io.err('install: no .git or .husky directory here — skipping git hooks');
    return [];
  }
  const changes: Change[] = [];
  for (const [hook, suite, from] of [
    ['pre-commit', 'commit', 'git-staged'],
    ['pre-push', 'push', 'project'],
  ] as const) {
    const file = path.join(target.dir, hook);
    const script = hookScript(suite, from);
    let existing: string | undefined;
    try {
      existing = await readFile(file, 'utf8');
    } catch {
      existing = undefined;
    }
    if (existing !== undefined && !existing.includes(HOOK_MARKER) && !force) {
      io.err(
        `install: ${path.relative(root, file)} already exists and is not ours — ` +
          `add \`static-x check ${suite} --from ${from}\` to it, or pass --force`,
      );
      continue;
    }
    if (existing === script) continue;
    changes.push({
      file,
      note: existing === undefined ? 'create' : 'update',
      write: async () => {
        await mkdir(target.dir, { recursive: true });
        await writeFile(file, script, 'utf8');
        // Husky sources its hooks; git's own must be executable.
        if (!target.husky) await chmod(file, 0o755);
      },
    });
  }
  return changes;
}

async function claudeChanges(root: string): Promise<Change[]> {
  const file = path.join(root, '.claude/settings.json');
  const settings = (await readJson(file)) ?? {};
  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
  const postToolUse = Array.isArray(hooks['PostToolUse']) ? [...(hooks['PostToolUse'] as unknown[])] : [];

  const already = JSON.stringify(postToolUse).includes(CLAUDE_MARKER);
  if (already) return [];

  postToolUse.push({
    matcher: 'Edit|Write',
    hooks: [
      {
        type: 'command',
        command: CLAUDE_HOOK_COMMAND,
        timeout: 60,
        statusMessage: 'Checking with static-x...',
      },
    ],
  });
  const next = { ...settings, hooks: { ...hooks, PostToolUse: postToolUse } };
  return [
    {
      file,
      note: existsSync(file) ? 'update' : 'create',
      write: async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      },
    },
  ];
}

/**
 * Materializing the defaults rather than relying on them is deliberate:
 * a gate you cannot read is a gate you cannot argue with, and the first
 * thing anyone wants after installing this is to see what it will
 * reject and change one line of it.
 */
async function configChanges(root: string): Promise<Change[]> {
  const file = path.join(root, CONFIG_FILENAME);
  const config = (await readJson(file)) ?? {};
  if (config['checks'] !== undefined) return [];

  const checks: Record<string, unknown> = {};
  for (const [name, suite] of Object.entries(TS_DEFAULT_CHECKS)) {
    checks[name] = serializeSuite(suite);
  }
  const next = { checks, ...config };
  return [
    {
      file,
      note: existsSync(file) ? 'add checks block' : 'create',
      write: () => writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8'),
    },
  ];
}

/** Back to the config spelling: a bare level unless there is tuning. */
function serializeSuite(suite: CheckSuite): Record<string, unknown> {
  const tools: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(suite.tools)) {
    tools[name] = entry.config ? { level: entry.level, ...entry.config } : entry.level;
  }
  return { novelty: suite.novelty, tools };
}

export async function runInstall(argv: string[], io: CliIo): Promise<number> {
  let values: { project?: string; target?: string[]; force?: boolean; 'dry-run'?: boolean };
  try {
    values = parseArgs({
      args: argv,
      options: {
        project: { type: 'string' },
        target: { type: 'string', multiple: true },
        force: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
      },
    }).values;
  } catch (error) {
    io.err(String(error instanceof Error ? error.message : error));
    return 2;
  }

  const targets = new Set(values.target ?? ['git', 'claude', 'config']);
  for (const target of targets) {
    if (target !== 'git' && target !== 'claude' && target !== 'config') {
      io.err(`--target must be one of git, claude, config (got ${target})`);
      return 2;
    }
  }

  const cwd = io.cwd ?? process.cwd();
  const root = path.resolve(values.project ?? cwd);
  const dryRun = values['dry-run'] ?? false;

  let changes: Change[];
  try {
    changes = [
      ...(targets.has('config') ? await configChanges(root) : []),
      ...(targets.has('git') ? await gitChanges(root, values.force ?? false, io) : []),
      ...(targets.has('claude') ? await claudeChanges(root) : []),
    ];
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (changes.length === 0) {
    io.out('Nothing to do — everything requested is already installed.');
    return 0;
  }

  for (const change of changes) {
    const where = path.relative(cwd, change.file) || change.file;
    if (dryRun) {
      io.out(`would ${change.note}: ${where}`);
      continue;
    }
    await change.write?.();
    io.out(`${change.note}: ${where}`);
  }

  if (!dryRun) {
    io.out('');
    io.out('Try it: `static-x check commit` — and `static-x check --list` to see the suites.');
    if (targets.has('git')) {
      io.out('The push suite reports against a baseline; record one with `static-x baseline`.');
    }
  }
  return 0;
}
