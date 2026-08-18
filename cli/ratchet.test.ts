import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './run.js';
import type { CliIo } from './io.js';

/**
 * The ratchet rewrites both static-x.json and the baseline, so every
 * test here runs against a disposable copy of the fixture.
 */
const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/checks-ts');

const temps: string[] = [];
async function fixtureCopy(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-x-ratchet-'));
  await cp(FIXTURE, dir, { recursive: true });
  temps.push(dir);
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

const suites = async (root: string) =>
  (
    JSON.parse(await readFile(path.join(root, 'static-x.json'), 'utf8')) as {
      checks: Record<string, { novelty: string; tools: Record<string, unknown> }>;
    }
  ).checks;

/** Records the baseline for `recorded`, whose only tool is comment.long. */
async function withBaseline(): Promise<string> {
  const root = await fixtureCopy();
  await runCli(['baseline', 'recorded', '--project', root], capture(root).io);
  return root;
}

describe('static-x ratchet', () => {
  it('reports what stopped reproducing, and writes nothing by default', async () => {
    const root = await withBaseline();
    await rm(path.join(root, 'src/wordy.ts'));

    const c = capture(root);
    expect(await runCli(['ratchet', 'recorded', '--project', root], c.io)).toBe(0);
    expect(c.stdout()).toMatch(/recorded: baseline 1 → 0 \(1 entry resolved\)/);
    expect(c.stdout()).toMatch(/Dry run — pass --apply to write these\./);

    // Untouched: the baseline still accounts for the finding that is gone.
    const baseline = JSON.parse(await readFile(path.join(root, 'static-x-baseline.json'), 'utf8')) as {
      findings: Record<string, number>;
    };
    expect(Object.keys(baseline.findings)).toHaveLength(1);
  });

  it('retires the baseline entirely once it empties', async () => {
    const root = await withBaseline();
    await rm(path.join(root, 'src/wordy.ts'));

    const c = capture(root);
    expect(await runCli(['ratchet', 'recorded', '--project', root, '--apply'], c.io)).toBe(0);
    expect(c.stdout()).toMatch(/novelty baseline → none/);
    expect(c.stdout()).toMatch(/Removed static-x-baseline\.json/);

    expect(existsSync(path.join(root, 'static-x-baseline.json'))).toBe(false);
    expect((await suites(root))['recorded']?.novelty).toBe('none');
  });

  it('shrinks the baseline without retiring it while findings remain', async () => {
    const root = await fixtureCopy();
    await cp(path.join(root, 'src/wordy.ts'), path.join(root, 'src/wordy2.ts'));
    await runCli(['baseline', 'recorded', '--project', root], capture(root).io);
    await rm(path.join(root, 'src/wordy2.ts'));

    const c = capture(root);
    expect(await runCli(['ratchet', 'recorded', '--project', root, '--apply'], c.io)).toBe(0);
    expect(c.stdout()).toMatch(/baseline 2 → 1/);
    expect(c.stdout()).not.toMatch(/novelty/);
    expect(existsSync(path.join(root, 'static-x-baseline.json'))).toBe(true);
    expect((await suites(root))['recorded']?.novelty).toBe('baseline');
  });

  it('refuses while anything regressed, and writes nothing', async () => {
    const root = await withBaseline();
    await cp(path.join(root, 'src/wordy.ts'), path.join(root, 'src/wordy2.ts'));

    const c = capture(root);
    expect(await runCli(['ratchet', 'recorded', '--project', root, '--apply'], c.io)).toBe(1);
    expect(c.stderr()).toMatch(/1 finding regressed since the baseline was recorded/);
    expect(c.stderr()).toMatch(/wordy2\.ts.*0 → 1/);
    expect(c.stdout()).not.toMatch(/Updated/);
  });

  it('promotes a warn tool that reports nothing across the project', async () => {
    const root = await fixtureCopy();
    const c = capture(root);
    expect(await runCli(['ratchet', 'promotable', '--project', root, '--apply'], c.io)).toBe(0);
    expect(c.stdout()).toMatch(/ts\/graph\/cycles {2}warn → block/);

    const tools = (await suites(root))['promotable']?.tools;
    expect(tools?.['ts/graph/cycles']).toBe('block');
    // comment.long reports something, so it stays where it is.
    expect(tools?.['ts/comments/long']).toBe('warn');
  });

  it('is idempotent', async () => {
    const root = await fixtureCopy();
    await runCli(['ratchet', 'promotable', '--project', root, '--apply'], capture(root).io);
    const second = capture(root);
    expect(await runCli(['ratchet', 'promotable', '--project', root], second.io)).toBe(0);
    expect(second.stdout()).toMatch(/nothing to tighten/);
  });

  it('preserves the rest of static-x.json when it writes', async () => {
    const root = await fixtureCopy();
    const file = path.join(root, 'static-x.json');
    const config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    config['ts'] = { comments: { long: { input: { maxLines: 20 } } } };
    await writeFile(file, JSON.stringify(config, null, 2), 'utf8');

    await runCli(['ratchet', 'promotable', '--project', root, '--apply'], capture(root).io);
    const after = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(after['ts']).toEqual({ comments: { long: { input: { maxLines: 20 } } } });
    // Suites it did not touch survive the rewrite verbatim.
    expect((after['checks'] as Record<string, unknown>)['whole']).toEqual({
      novelty: 'none',
      tools: { 'ts/comments/long': { level: 'block', input: { maxLines: 3 } } },
    });
  });

  /**
   * Narrowing is for running, never for writing. A registered tool
   * whose pack does not bind here is still a real entry in this file,
   * and dropping it would silently disarm that gate everywhere else
   * the config travels — a checkout with only the TypeScript half of a
   * mixed repo would delete the Swift half's gates on first ratchet.
   *
   * This needs a tool that is registered but does not bind, which was
   * unconstructible while one pack shipped: resolveSuite rejects an
   * unregistered name outright, so a config naming one bails before
   * the write is ever reached.
   */
  it('keeps entries for a registered pack that does not bind here', async () => {
    const root = await fixtureCopy();
    const file = path.join(root, 'static-x.json');
    const config = JSON.parse(await readFile(file, 'utf8')) as {
      checks: Record<string, { novelty: string; tools: Record<string, unknown> }>;
    };
    const promotable = config.checks['promotable'];
    expect(promotable).toBeDefined();
    promotable!.tools['swift/comments/long'] = { level: 'warn' };
    await writeFile(file, JSON.stringify(config, null, 2), 'utf8');

    const c = capture(root);
    expect(await runCli(['ratchet', 'promotable', '--project', root, '--apply'], c.io)).toBe(0);

    const after = await suites(root);
    expect(after['promotable']?.tools['swift/comments/long']).toBe('warn');
    // And the TypeScript half was still measured and tightened around
    // it, so preserving the Swift entry did not cost the run.
    expect(after['promotable']?.tools['ts/graph/cycles']).toBe('block');
  });

  it('says a suite with no baseline needs one first', async () => {
    const root = await fixtureCopy();
    const c = capture(root);
    expect(await runCli(['ratchet', 'recorded', '--project', root], c.io)).toBe(1);
    expect(c.stderr()).toMatch(/run `static-x baseline` first/);
  });

  it('considers every suite when none is named', async () => {
    const root = await fixtureCopy();
    const c = capture(root);
    await runCli(['ratchet', '--project', root], c.io);
    for (const suite of ['advisory', 'gate', 'promotable', 'whole']) {
      expect(c.stdout() + c.stderr(), suite).toMatch(new RegExp(`^${suite}:`, 'm'));
    }
  });

  it('exits 2 on an unknown suite', async () => {
    const root = await fixtureCopy();
    const c = capture(root);
    expect(await runCli(['ratchet', 'nope', '--project', root], c.io)).toBe(2);
    expect(c.stderr()).toMatch(/Unknown check suite/);
  });
});
