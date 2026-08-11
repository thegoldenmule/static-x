import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './run.js';
import type { CliIo } from './io.js';

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/checks-ts');

const temps: string[] = [];
async function fixtureCopy(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-x-todo-'));
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

/** A suite whose one tool reports something an agent may act on. */
async function withStaleRefSuite(): Promise<string> {
  const root = await fixtureCopy();
  await writeFile(
    path.join(root, 'src/refs.ts'),
    ['/** Calls {@link nowhereAtAll} to do the thing. */', 'export const refs = 1;', ''].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(root, 'static-x.json'),
    JSON.stringify({
      checks: { queue: { novelty: 'baseline', tools: { 'ts/comments/stale-refs': 'warn' } } },
    }),
    'utf8',
  );
  return root;
}

describe('static-x todo', () => {
  it('lists what the baseline is hiding, and exits 1 while there is work', async () => {
    const root = await withStaleRefSuite();
    await runCli(['baseline', 'queue', '--project', root], capture(root).io);

    const c = capture(root);
    expect(await runCli(['todo', 'queue', '--project', root], c.io)).toBe(1);
    expect(c.stdout()).toMatch(/src\/refs\.ts {2}\(1\)/);
    expect(c.stdout()).toMatch(/nowhereAtAll/);
    expect(c.stdout()).toMatch(/queue: 1 actionable in 1 file, of 1 in the backlog/);
  });

  it('exits 2 rather than guessing when no baseline was recorded', async () => {
    const root = await withStaleRefSuite();
    const c = capture(root);
    expect(await runCli(['todo', 'queue', '--project', root], c.io)).toBe(2);
    expect(c.stderr()).toMatch(/no baseline recorded/);
  });

  it('exits 0 and points at ratchet once the backlog is clear', async () => {
    const root = await withStaleRefSuite();
    await runCli(['baseline', 'queue', '--project', root], capture(root).io);
    // Resolve the finding the way the loop's "ignore" answer would.
    await writeFile(
      path.join(root, 'static-x.json'),
      JSON.stringify({
        checks: { queue: { novelty: 'baseline', tools: { 'ts/comments/stale-refs': 'warn' } } },
        ts: { comments: { 'stale-refs': { ignore: ['nowhereAtAll'] } } },
      }),
      'utf8',
    );

    const c = capture(root);
    expect(await runCli(['todo', 'queue', '--project', root], c.io)).toBe(0);
    expect(c.stdout()).toMatch(/baseline is empty — `static-x ratchet --apply` can retire it/);
  });

  it('holds back codes an agent should not act on, and names them', async () => {
    const root = await fixtureCopy();
    await writeFile(
      path.join(root, 'static-x.json'),
      JSON.stringify({
        checks: { dead: { novelty: 'baseline', tools: { 'ts/graph/dead-exports': 'warn' } } },
      }),
      'utf8',
    );
    await runCli(['baseline', 'dead', '--project', root], capture(root).io);

    const c = capture(root);
    // Deleting an export may remove public API no test covers, so the
    // queue reports the backlog without offering it as work.
    expect(await runCli(['todo', 'dead', '--project', root], c.io)).toBe(0);
    expect(c.stdout()).toMatch(/nothing actionable/);
    expect(c.stdout()).toMatch(/held back: graph\.dead-file/);
  });

  it('--all drops the restriction, for a human deciding', async () => {
    const root = await fixtureCopy();
    await writeFile(
      path.join(root, 'static-x.json'),
      JSON.stringify({
        checks: { dead: { novelty: 'baseline', tools: { 'ts/graph/dead-exports': 'warn' } } },
      }),
      'utf8',
    );
    await runCli(['baseline', 'dead', '--project', root], capture(root).io);

    const c = capture(root);
    expect(await runCli(['todo', 'dead', '--project', root, '--all'], c.io)).toBe(1);
    expect(c.stdout()).toMatch(/graph\.dead-file/);
  });

  it('honours a project overriding the fixable set', async () => {
    const root = await fixtureCopy();
    await writeFile(
      path.join(root, 'static-x.json'),
      JSON.stringify({
        checks: { dead: { novelty: 'baseline', tools: { 'ts/graph/dead-exports': 'warn' } } },
        todo: { codes: ['graph.dead-file'] },
      }),
      'utf8',
    );
    await runCli(['baseline', 'dead', '--project', root], capture(root).io);

    const c = capture(root);
    expect(await runCli(['todo', 'dead', '--project', root], c.io)).toBe(1);
    expect(c.stdout()).toMatch(/graph\.dead-file/);
  });

  it('caps the queue with --limit', async () => {
    const root = await withStaleRefSuite();
    await writeFile(
      path.join(root, 'src/refs.ts'),
      [
        '/** Calls {@link nowhereAtAll} and {@link alsoMissing}. */',
        'export const refs = 1;',
        '',
      ].join('\n'),
      'utf8',
    );
    await runCli(['baseline', 'queue', '--project', root], capture(root).io);

    const c = capture(root);
    expect(await runCli(['todo', 'queue', '--project', root, '--limit', '1'], c.io)).toBe(1);
    expect(c.stdout()).toMatch(/queue: 1 actionable/);
  });

  it('reports as JSON, carrying the data.name an ignore entry needs', async () => {
    const root = await withStaleRefSuite();
    await runCli(['baseline', 'queue', '--project', root], capture(root).io);

    const c = capture(root);
    expect(await runCli(['todo', 'queue', '--project', root, '--format', 'json'], c.io)).toBe(1);
    const report = JSON.parse(c.stdout()) as {
      count: number;
      files: { file: string; items: { finding: { data: { name: string } } }[] }[];
    };
    expect(report.count).toBe(1);
    expect(report.files[0]?.items[0]?.finding.data.name).toBe('nowhereAtAll');
  });

  it('rejects a bad --limit or --format', async () => {
    const root = await withStaleRefSuite();
    const limit = capture(root);
    expect(await runCli(['todo', 'queue', '--project', root, '--limit', 'lots'], limit.io)).toBe(2);
    expect(limit.stderr()).toMatch(/--limit must be a positive integer/);

    const format = capture(root);
    expect(await runCli(['todo', 'queue', '--project', root, '--format', 'yaml'], format.io)).toBe(2);
    expect(format.stderr()).toMatch(/--format must be json or text/);
  });
});
