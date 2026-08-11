import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookScript } from '../cli/install.js';

/**
 * The shipped hooks are what `static-x install` writes, and people copy
 * them by hand too, so they get the same treatment as shipped code:
 * syntax-checked, executable, and — for the Claude Code settings, whose
 * command string is the whole contract — driven end to end.
 */
const HOOKS = path.resolve(import.meta.dirname);
const REPO = path.resolve(HOOKS, '..');
const FIXTURE = path.join(REPO, 'fixtures/checks-ts');
const CLI = path.join(REPO, 'cli/sx.mjs');

const GIT_HOOKS = [
  { file: 'git/pre-commit', suite: 'commit', from: 'git-staged' },
  { file: 'git/pre-push', suite: 'push', from: 'project' },
] as const;

describe('example hooks', () => {
  it('ships shell hooks that parse and are executable', () => {
    for (const { file } of GIT_HOOKS) {
      const hook = path.join(HOOKS, file);
      expect((statSync(hook).mode & 0o111) !== 0, `${file} is not executable`).toBe(true);
      const check = spawnSync('sh', ['-n', hook], { encoding: 'utf8' });
      expect(check.status, `${file}: ${check.stderr}`).toBe(0);
    }
  });

  it('ships exactly what the installer writes', async () => {
    // Documentation people copy cannot drift from the thing that
    // generates it without one of the two being wrong.
    for (const { file, suite, from } of GIT_HOOKS) {
      expect(await readFile(path.join(HOOKS, file), 'utf8'), file).toBe(hookScript(suite, from));
    }
  });

  it('registers a Claude Code command that runs', async () => {
    const settings = JSON.parse(
      await readFile(path.join(HOOKS, 'claude/settings.example.json'), 'utf8'),
    ) as { hooks: { PostToolUse: { matcher: string; hooks: { command: string }[] }[] } };
    const entry = settings.hooks.PostToolUse[0];
    expect(entry?.matcher).toBe('Edit|Write');
    expect(entry?.hooks[0]?.command).toMatch(/check claude --from claude/);
  });
});

/** Drives the CLI as a Claude Code PostToolUse hook would. */
function runClaudeHook(filePath: string, suite = 'gate'): { status: number; stderr: string } {
  const result = spawnSync(
    'node',
    [CLI, 'check', suite, '--from', 'claude', '--project', FIXTURE],
    {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        cwd: FIXTURE,
        tool_input: { file_path: filePath },
      }),
      encoding: 'utf8',
    },
  );
  return { status: result.status ?? -1, stderr: result.stderr };
}

describe('the Claude Code contract, end to end', () => {
  it('blocks with exit 2 and explains itself', () => {
    const { status, stderr } = runClaudeHook(path.join(FIXTURE, 'src/dropped.ts'));
    expect(status).toBe(2);
    expect(stderr).toContain('async.floating-promise');
    expect(stderr).toContain('Fix these in the file you just wrote');
  });

  it('stays silent on a clean file and a non-source file', () => {
    expect(runClaudeHook(path.join(FIXTURE, 'src/clean.ts'))).toEqual({ status: 0, stderr: '' });
    expect(runClaudeHook(path.join(FIXTURE, 'README.md'))).toEqual({ status: 0, stderr: '' });
  });

  it('never blocks the session when the check cannot run', () => {
    // static-x's own "could not run" is exit 2, which is Claude's
    // "block" — so a misconfigured hook has to come back as 0.
    const { status, stderr } = runClaudeHook(path.join(FIXTURE, 'src/dropped.ts'), 'no-such-suite');
    expect(status).toBe(0);
    expect(stderr).toContain('Unknown check suite');
  });
});
