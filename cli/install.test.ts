import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './run.js';
import type { CliIo } from './run.js';

/**
 * The installer writes files into a project, so every test here runs in
 * a throwaway directory shaped like one.
 */
const temps: string[] = [];
async function project(layout: 'husky' | 'git' | 'bare'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-x-install-'));
  temps.push(dir);
  if (layout === 'husky') await mkdir(path.join(dir, '.husky'), { recursive: true });
  if (layout === 'git') await mkdir(path.join(dir, '.git'), { recursive: true });
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function capture(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l), cwd };
  return { io, stdout: () => out.join('\n'), stderr: () => err.join('\n') };
}

const read = (root: string, file: string) => readFile(path.join(root, file), 'utf8');

describe('static-x install', () => {
  it('writes husky hooks, the Claude settings, and the suites', async () => {
    const root = await project('husky');
    const c = capture(root);
    expect(await runCli(['install', '--project', root], c.io)).toBe(0);

    const preCommit = await read(root, '.husky/pre-commit');
    expect(preCommit).toMatch(/check commit --from git-staged/);
    // The script holds no policy — it points at the config instead.
    expect(preCommit).toMatch(/configured in static-x\.json/);
    expect(await read(root, '.husky/pre-push')).toMatch(/check push --from project/);

    const settings = JSON.parse(await read(root, '.claude/settings.json')) as {
      hooks: { PostToolUse: { matcher: string; hooks: { command: string }[] }[] };
    };
    expect(settings.hooks.PostToolUse[0]?.matcher).toBe('Edit|Write');
    expect(settings.hooks.PostToolUse[0]?.hooks[0]?.command).toMatch(/static-x check claude/);

    const config = JSON.parse(await read(root, 'static-x.json')) as {
      checks: Record<string, { novelty: string; tools: Record<string, unknown> }>;
    };
    expect(Object.keys(config.checks).sort()).toEqual(['claude', 'commit', 'push']);
    expect(config.checks['commit']?.novelty).toBe('changed-lines');
    // Bare level where there is no tuning, long form where there is.
    expect(config.checks['commit']?.tools['ts/async/floating-promises']).toBe('block');
    expect(config.checks['claude']?.tools['ts/types/loopholes']).toEqual({
      level: 'block',
      minSeverity: 'warning',
    });
  });

  it('writes executable hooks into .git/hooks when husky is absent', async () => {
    const root = await project('git');
    expect(await runCli(['install', '--project', root, '--target', 'git'], capture(root).io)).toBe(0);
    const hook = path.join(root, '.git/hooks/pre-commit');
    expect(await readFile(hook, 'utf8')).toMatch(/check commit --from git-staged/);
    // Husky sources its hooks; git's own must carry the bit itself.
    expect((await stat(hook)).mode & 0o111).not.toBe(0);
  });

  it('preserves what static-x.json already says', async () => {
    const root = await project('husky');
    await writeFile(
      path.join(root, 'static-x.json'),
      JSON.stringify({ ts: { comments: { long: { input: { maxLines: 20 } } } } }),
      'utf8',
    );
    await runCli(['install', '--project', root, '--target', 'config'], capture(root).io);
    const config = JSON.parse(await read(root, 'static-x.json')) as Record<string, unknown>;
    expect(config['ts']).toEqual({ comments: { long: { input: { maxLines: 20 } } } });
    expect(config['checks']).toBeDefined();
  });

  it('leaves an existing checks block and an existing hook alone', async () => {
    const root = await project('husky');
    await writeFile(path.join(root, 'static-x.json'), JSON.stringify({ checks: { mine: {} } }), 'utf8');
    await writeFile(path.join(root, '.husky/pre-commit'), '#!/bin/sh\nnpm test\n', 'utf8');

    const c = capture(root);
    expect(await runCli(['install', '--project', root], c.io)).toBe(0);
    expect(JSON.parse(await read(root, 'static-x.json'))).toEqual({ checks: { mine: {} } });
    expect(await read(root, '.husky/pre-commit')).toBe('#!/bin/sh\nnpm test\n');
    expect(c.stderr()).toMatch(/already exists and is not ours/);
    // pre-push had no conflict, so it still landed.
    expect(await read(root, '.husky/pre-push')).toMatch(/check push --from project/);
  });

  it('overwrites a foreign hook only with --force', async () => {
    const root = await project('husky');
    await writeFile(path.join(root, '.husky/pre-commit'), '#!/bin/sh\nnpm test\n', 'utf8');
    await runCli(['install', '--project', root, '--target', 'git', '--force'], capture(root).io);
    expect(await read(root, '.husky/pre-commit')).toMatch(/check commit --from git-staged/);
  });

  it('is idempotent', async () => {
    const root = await project('husky');
    await runCli(['install', '--project', root], capture(root).io);
    const second = capture(root);
    expect(await runCli(['install', '--project', root], second.io)).toBe(0);
    expect(second.stdout()).toMatch(/Nothing to do/);

    const settings = JSON.parse(await read(root, '.claude/settings.json')) as {
      hooks: { PostToolUse: unknown[] };
    };
    expect(settings.hooks.PostToolUse).toHaveLength(1);
  });

  it('writes nothing under --dry-run', async () => {
    const root = await project('husky');
    const c = capture(root);
    expect(await runCli(['install', '--project', root, '--dry-run'], c.io)).toBe(0);
    expect(c.stdout()).toMatch(/would create: static-x\.json/);
    expect(c.stdout()).toMatch(/would create: \.husky\/pre-commit/);
    await expect(read(root, 'static-x.json')).rejects.toThrow();
  });

  it('says so rather than guessing when there is no git directory', async () => {
    const root = await project('bare');
    const c = capture(root);
    expect(await runCli(['install', '--project', root, '--target', 'git'], c.io)).toBe(0);
    expect(c.stderr()).toMatch(/no \.git or \.husky directory/);
  });

  it('rejects an unknown target', async () => {
    const root = await project('husky');
    const c = capture(root);
    expect(await runCli(['install', '--project', root, '--target', 'jenkins'], c.io)).toBe(2);
    expect(c.stderr()).toMatch(/--target must be one of/);
  });
});
