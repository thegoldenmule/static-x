import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The example gate gets the same treatment as the hooks the installer
 * writes: driven end to end against a fixture, through the exit codes
 * Claude Code actually reads. Its whole contract is that 2 blocks, 0
 * does not, and neither happens for the wrong reason.
 */
const HERE = path.resolve(import.meta.dirname);
const REPO = path.resolve(HERE, '../..');
const SCRIPT = path.join(HERE, 'ts-comments.mts');
const FIXTURE = path.join(REPO, 'fixtures/claude-comments-ts');
const BIN = path.join(REPO, 'cli/sx.mjs');

/**
 * `changed-lines` asks which lines a file has that HEAD does not, so the
 * fixture needs a history of its own — read in place it would only ever
 * be a clean tracked file in this repository.
 */
let root: string;

function git(...args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'static-x-claude-comments-'));
  cpSync(FIXTURE, root, { recursive: true });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'fixture');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Run {
  status: number;
  stderr: string;
  stdout: string;
}

/** Drives the script exactly as a PostToolUse hook invocation would. */
function edit(relative: string): Run {
  const file = path.join(root, relative);
  const result = spawnSync('node', [SCRIPT], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      cwd: root,
      tool_input: { file_path: file },
    }),
    encoding: 'utf8',
    env: { ...process.env, STATIC_X_BIN: BIN, CLAUDE_PROJECT_DIR: root },
  });
  return { status: result.status ?? -1, stderr: result.stderr, stdout: result.stdout };
}

// Node strips types from .mts without a loader from 22.18 and 23.6; the
// example targets that on purpose, since a copy in ~/.claude/hooks has
// neither a build step nor a package.json to make it ESM.
const runnable = process.features.typescript !== false && process.features.typescript !== undefined;

describe.skipIf(!runnable)('the claude-comments example gate', () => {
  it('blocks a comment the change added, over the limit the suite sets', () => {
    appendFileSync(
      path.join(root, 'src/terse.ts'),
      '\n/**\n * Three lines is one more\n * than this gate allows.\n */\nexport const added = 3;\n',
    );
    const { status, stderr } = edit('src/terse.ts');
    expect(status).toBe(2);
    expect(stderr).toContain('comment.long');
    expect(stderr).toContain('spans 4 lines (limit 2)');
  });

  it('leaves a comment the change did not touch alone', () => {
    // The whole reason novelty exists: wordy.ts opens with a comment
    // over the limit, and an edit elsewhere in it is not answerable for
    // that. Without the filter this is the finding that gets the hook
    // uninstalled.
    appendFileSync(path.join(root, 'src/wordy.ts'), '\nexport const appended = 2;\n');
    expect(edit('src/wordy.ts')).toMatchObject({ status: 0, stderr: '' });
  });

  it('reports a warn-level tool as context instead of blocking', () => {
    appendFileSync(
      path.join(root, 'src/terse.ts'),
      '\nexport function add(a: number, b: number): number {\n' +
        '  // Add a and b and return the result\n  return a + b;\n}\n',
    );
    const { status, stdout } = edit('src/terse.ts');
    expect(status).toBe(0);
    const output = JSON.parse(stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(output.hookSpecificOutput.additionalContext).toContain('comment.llm-tell');
    expect(output.hookSpecificOutput.additionalContext).toContain('advisory');
  });

  it('ignores an edit that is not TypeScript', () => {
    appendFileSync(path.join(root, 'README.md'), '\nA sentence long enough to be a comment.\n');
    expect(edit('README.md')).toMatchObject({ status: 0, stderr: '', stdout: '' });
  });

  it('fails open on a config it cannot read, and says so', () => {
    // static-x's own "could not run" is exit 2, which is Claude's
    // "block" — so every failure here has to come back as 0, loudly.
    writeFileSync(path.join(root, 'static-x.json'), '{ "checks": ');
    appendFileSync(path.join(root, 'src/terse.ts'), '\n/**\n * Over\n * the limit.\n */\n');
    const { status, stdout } = edit('src/terse.ts');
    expect(status).toBe(0);
    const output = JSON.parse(stdout) as { systemMessage: string };
    expect(output.systemMessage).toContain('config is invalid');
  });
});
