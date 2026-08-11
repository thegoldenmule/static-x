import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './run.js';
import type { CliIo } from './run.js';

/**
 * End-to-end coverage of the command a hook actually runs. The exit
 * codes are the contract here — a git hook blocks on 1 and a Claude
 * Code hook blocks on 2 — so every case asserts one.
 */
const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/checks-ts');

function capture(options: { cwd?: string; stdin?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    cwd: options.cwd ?? FIXTURE,
    ...(options.stdin === undefined
      ? {}
      : { readStdin: (): Promise<string> => Promise.resolve(options.stdin ?? '') }),
  };
  return { out, err, io, stdout: () => out.join('\n'), stderr: () => err.join('\n') };
}

const temps: string[] = [];
async function fixtureCopy(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-x-checks-'));
  await cp(FIXTURE, dir, { recursive: true });
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function claudeEvent(file: string): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    cwd: FIXTURE,
    tool_input: { file_path: file },
  });
}

describe('static-x check', () => {
  it('lists the suites with each tool and its level', async () => {
    const c = capture();
    expect(await runCli(['check', '--list', '--project', FIXTURE], c.io)).toBe(0);
    expect(c.stdout()).toMatch(/^gate \(changed-file\)$/m);
    expect(c.stdout()).toMatch(/block ts\/async\/floating-promises/);
    expect(c.stdout()).toMatch(/warn {2}ts\/comments\/long/);
    // An `off` tool is not listed: it does not run, so it is not a gate.
    expect(c.stdout()).not.toMatch(/off {3}ts\/async/);
  });

  it('exits 1 and prints the blocking finding', async () => {
    const c = capture();
    expect(await runCli(['check', 'whole', '--project', FIXTURE], c.io)).toBe(1);
    // Blocking output goes to stderr — it is the reason for the rejection.
    expect(c.stderr()).toMatch(/Blocking \(1\):/);
    expect(c.stderr()).toMatch(/src\/wordy\.ts:1:1 {2}info {2}comment\.long/);
  });

  it('exits 0 when only advisory tools report', async () => {
    const c = capture();
    expect(await runCli(['check', 'advisory', '--project', FIXTURE], c.io)).toBe(0);
    expect(c.stdout()).toMatch(/Advisory \(1\) — reported, not blocking:/);
    expect(c.stdout()).toMatch(/comment\.long/);
  });

  it('separates blocking from advisory in one report', async () => {
    const c = capture();
    expect(await runCli(['check', 'gate', '--from', 'project', '--project', FIXTURE], c.io)).toBe(1);
    expect(c.stderr()).toMatch(/Blocking \(1\):[\s\S]*async\.floating-promise/);
    expect(c.stderr()).toMatch(/Advisory \(1\)[\s\S]*comment\.long/);
  });

  it('says so when the requested novelty could not be applied', async () => {
    const c = capture();
    await runCli(['check', 'gate', '--from', 'project', '--project', FIXTURE], c.io);
    // Silence here would look exactly like a gate that found something
    // real, which is the failure this note exists to prevent.
    expect(c.stderr()).toMatch(/no changed-file list available; reporting on the whole project/);
  });

  it('reports as JSON on request', async () => {
    const c = capture();
    expect(await runCli(['check', 'whole', '--project', FIXTURE, '--format', 'json'], c.io)).toBe(1);
    const report = JSON.parse(c.stdout()) as {
      suite: string;
      blocking: { code: string }[];
      advisory: unknown[];
      novelty: string;
    };
    expect(report.suite).toBe('whole');
    expect(report.novelty).toBe('none');
    expect(report.blocking.map((f) => f.code)).toEqual(['comment.long']);
    expect(report.advisory).toEqual([]);
  });

  it('exits 2 on an unknown suite, listing the ones that exist', async () => {
    const c = capture();
    expect(await runCli(['check', 'nope', '--project', FIXTURE], c.io)).toBe(2);
    expect(c.stderr()).toMatch(/Unknown check suite "nope"/);
    // The project's own suites plus the defaults it did not override.
    expect(c.stderr()).toMatch(/advisory, claude, commit, gate, push, recorded, whole/);
  });

  it('exits 2 on a bad --from or --format', async () => {
    const bad = capture();
    expect(await runCli(['check', 'whole', '--project', FIXTURE, '--from', 'psychic'], bad.io)).toBe(2);
    expect(bad.stderr()).toMatch(/--from must be one of/);

    const format = capture();
    expect(await runCli(['check', 'whole', '--project', FIXTURE, '--format', 'yaml'], format.io)).toBe(2);
    expect(format.stderr()).toMatch(/--format must be json or text/);
  });

  describe('--from claude', () => {
    it('blocks with exit 2 and tells the model what to fix', async () => {
      const c = capture({ stdin: claudeEvent(path.join(FIXTURE, 'src/dropped.ts')) });
      expect(await runCli(['check', 'gate', '--from', 'claude', '--project', FIXTURE], c.io)).toBe(2);
      expect(c.stderr()).toMatch(/async\.floating-promise/);
      expect(c.stderr()).toMatch(/Fix these in the file you just wrote/);
      // Nothing on stdout: Claude reads stderr.
      expect(c.stdout()).toBe('');
    });

    it('scopes to the edited file, ignoring findings elsewhere', async () => {
      const c = capture({ stdin: claudeEvent(path.join(FIXTURE, 'src/clean.ts')) });
      expect(await runCli(['check', 'gate', '--from', 'claude', '--project', FIXTURE], c.io)).toBe(0);
      expect(c.stderr()).toBe('');
    });

    it('stays silent on a non-source file and on an event it cannot parse', async () => {
      const readme = capture({ stdin: claudeEvent(path.join(FIXTURE, 'README.md')) });
      expect(await runCli(['check', 'gate', '--from', 'claude', '--project', FIXTURE], readme.io)).toBe(0);
      expect(readme.stderr()).toBe('');

      const garbage = capture({ stdin: 'not json' });
      expect(await runCli(['check', 'gate', '--from', 'claude', '--project', FIXTURE], garbage.io)).toBe(0);
    });

    it('never wedges the session: a broken configuration exits 0', async () => {
      // Static-x's own "could not run" is exit 2, which is Claude's
      // "block" — so under this source every failure has to become 0.
      const c = capture({ stdin: claudeEvent(path.join(FIXTURE, 'src/dropped.ts')) });
      expect(await runCli(['check', 'nope', '--from', 'claude', '--project', FIXTURE], c.io)).toBe(0);
      expect(c.stderr()).toMatch(/Unknown check suite/);
    });
  });
});

describe('static-x baseline', () => {
  it('records the suite, after which it reports nothing', async () => {
    const root = await fixtureCopy();
    const record = capture({ cwd: root });
    expect(await runCli(['baseline', 'recorded', '--project', root], record.io)).toBe(0);
    expect(record.stdout()).toMatch(/Recorded 1 baseline entry/);

    const after = capture({ cwd: root });
    expect(await runCli(['check', 'recorded', '--project', root], after.io)).toBe(0);
    expect(after.stderr()).toBe('');
  });

  it('reports only what came after the recording', async () => {
    const root = await fixtureCopy();
    await runCli(['baseline', 'recorded', '--project', root], capture({ cwd: root }).io);

    const wordy = path.join(root, 'src/wordy.ts');
    const text = await readFile(wordy, 'utf8');
    await cp(wordy, path.join(root, 'src/second.ts'));
    expect(text).toMatch(/A comment block long enough/);

    const after = capture({ cwd: root });
    expect(await runCli(['check', 'recorded', '--project', root], after.io)).toBe(1);
    // The copy is a new finding in a new file; the original stays quiet.
    expect(after.stderr()).toMatch(/second\.ts/);
    expect(after.stderr()).not.toMatch(/wordy\.ts/);
  });

  it('exits 2 on an unknown suite', async () => {
    const c = capture();
    expect(await runCli(['baseline', 'nope', '--project', FIXTURE], c.io)).toBe(2);
    expect(c.stderr()).toMatch(/Unknown check suite/);
  });
});

describe('command routing', () => {
  it('rejects an unknown bare word, pointing at the path-like tool form', async () => {
    const c = capture();
    expect(await runCli(['frobnicate'], c.io)).toBe(2);
    expect(c.stderr()).toMatch(/Unknown command "frobnicate"/);
    expect(c.stderr()).toMatch(/ts\/comments\/long/);
  });

  it('still routes a path-like name to the tool runner', async () => {
    const c = capture();
    expect(await runCli(['ts/comments/long', '--project', FIXTURE, '--format', 'text'], c.io)).toBe(1);
    expect(c.stdout()).toMatch(/comment\.long/);
  });
});
