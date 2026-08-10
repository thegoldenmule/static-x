#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook: after Claude writes a TypeScript file,
 * run static-x on that one file and hand any findings back to the model.
 *
 * The event carries the edited path in tool_input.file_path, which is
 * exactly what --files wants, so the check costs one file's worth of
 * findings while still resolving symbols, imports, and duplicates
 * against the whole project.
 *
 * Exit codes are the Claude Code hook contract, not static-x's:
 *   0  nothing to say (also used when static-x is missing or fails —
 *      a hook should never wedge the session)
 *   2  blocking error; stderr is fed back to Claude, which then fixes
 *      the file and tries again
 *
 * Wire it up with the matcher in settings.example.json. Configure with:
 *   STATIC_X_TOOLS  space-separated tool names (default: ts/comments/long)
 *   STATIC_X_BIN    the static-x executable (default: static-x on PATH)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TOOLS = (process.env.STATIC_X_TOOLS ?? 'ts/comments/long').split(/\s+/).filter(Boolean);
const BIN = process.env.STATIC_X_BIN ?? 'static-x';
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;

async function readStdin() {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const event = await readStdin()
  .then((text) => JSON.parse(text))
  .catch(() => undefined);

const file = event?.tool_input?.file_path;
if (typeof file !== 'string' || !SOURCE_FILE.test(file)) process.exit(0);

// CLAUDE_PROJECT_DIR is exported into every hook process; the event's
// cwd is the fallback for hooks run outside a project directory.
const project = process.env.CLAUDE_PROJECT_DIR ?? event.cwd ?? process.cwd();

const reports = [];
for (const tool of TOOLS) {
  const run = spawnSync(
    BIN,
    [tool, '--project', project, '--files', file, '--format', 'text'],
    { encoding: 'utf8' },
  );
  if (run.error) process.exit(0); // not installed — stay out of the way
  if (run.status === 1) reports.push(run.stdout.trim());
  else if (run.status !== 0) {
    // Exit 0 with this on stderr: visible in the hook debug log, but
    // never blocking. A project mid-refactor should not trap Claude.
    console.error(`static-x ${tool} could not run: ${(run.stderr || run.stdout).trim()}`);
  }
}

if (reports.length === 0) process.exit(0);

console.error(
  [
    `static-x found problems in ${path.relative(project, file) || file}:`,
    '',
    ...reports,
    '',
    'Fix these in the file you just wrote before moving on.',
  ].join('\n'),
);
process.exit(2);
