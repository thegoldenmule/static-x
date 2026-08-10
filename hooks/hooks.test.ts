import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The example hooks are documentation people copy verbatim, so they get
 * the same treatment as shipped code: syntax-checked, executable, and —
 * for the Claude Code hook, whose exit codes are the whole contract —
 * driven end to end against a fixture project.
 */
const HOOKS = path.resolve(import.meta.dirname);
const REPO = path.resolve(HOOKS, '..');
const FIXTURE = path.join(REPO, 'fixtures/basic-ts');
const CLI = path.join(REPO, 'cli/sx.mjs');
const CLAUDE_HOOK = path.join(HOOKS, 'claude/reject-long-comments.mjs');

const GIT_HOOKS = ['git/pre-commit', 'git/pre-push'];

function isExecutable(file: string): boolean {
  return (statSync(file).mode & 0o111) !== 0;
}

/** Runs the PostToolUse hook on one edited file, as Claude Code would. */
function runClaudeHook(filePath: string, tools?: string): { status: number; stderr: string } {
  const result = spawnSync('node', [CLAUDE_HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      cwd: FIXTURE,
      tool_input: { file_path: filePath },
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      STATIC_X_BIN: CLI,
      CLAUDE_PROJECT_DIR: FIXTURE,
      ...(tools === undefined ? {} : { STATIC_X_TOOLS: tools }),
    },
  });
  return { status: result.status ?? -1, stderr: result.stderr };
}

describe('example hooks', () => {
  it('ships shell hooks that parse and are executable', () => {
    for (const hook of GIT_HOOKS) {
      const file = path.join(HOOKS, hook);
      expect(isExecutable(file), `${hook} is not executable`).toBe(true);
      const check = spawnSync('sh', ['-n', file], { encoding: 'utf8' });
      expect(check.status, `${hook}: ${check.stderr}`).toBe(0);
    }
  });

  it('ships a Claude Code hook that parses and is executable', () => {
    expect(isExecutable(CLAUDE_HOOK)).toBe(true);
    const check = spawnSync('node', ['--check', CLAUDE_HOOK], { encoding: 'utf8' });
    expect(check.status, check.stderr).toBe(0);
  });

  it('blocks with exit 2 and explains itself when the edited file has findings', () => {
    const { status, stderr } = runClaudeHook(path.join(FIXTURE, 'src/math.ts'));
    expect(status).toBe(2);
    expect(stderr).toContain('src/math.ts');
    expect(stderr).toContain('comment.long');
  });

  it('stays silent on a clean file, a non-source file, and an unrelated event', () => {
    expect(runClaudeHook(path.join(FIXTURE, 'src/greeter.ts'))).toEqual({ status: 0, stderr: '' });
    expect(runClaudeHook(path.join(FIXTURE, 'README.md'))).toEqual({ status: 0, stderr: '' });

    const noFile = spawnSync('node', [CLAUDE_HOOK], {
      input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} }),
      encoding: 'utf8',
      env: { ...process.env, STATIC_X_BIN: CLI },
    });
    expect(noFile.status).toBe(0);
  });

  it('never blocks the session when a tool cannot run', () => {
    // No such tool: static-x exits 2, which the hook reports without
    // blocking, so a misconfigured hook can't trap Claude.
    const { status, stderr } = runClaudeHook(path.join(FIXTURE, 'src/math.ts'), 'ts/nope/nope');
    expect(status).toBe(0);
    expect(stderr).toContain('could not run');
  });
});
