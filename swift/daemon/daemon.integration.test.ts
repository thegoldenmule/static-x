import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SERVE = path.join(import.meta.dirname, 'serve.ts');
import { callDaemon } from './client.js';
import { socketPath } from './socket.js';

/**
 * Proves the daemon path actually serves. Without this, every test in
 * swift/ferry would still pass against a daemon that never worked and
 * always fell back — which is the failure mode a fallback invites.
 */
const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/basic-swift');

describe('the daemon actually serves', () => {
  afterAll(async () => {
    // Leave no process behind for the next run to inherit.
    await callDaemon(FIXTURE, 'swift/noop', FIXTURE, {}, true).catch(() => undefined);
    await unlink(socketPath(FIXTURE)).catch(() => undefined);
  });

  it('spawns on first call, answers, and listens on this root’s socket', async () => {
    await unlink(socketPath(FIXTURE)).catch(() => undefined);
    // An unregistered tool is the cheapest round trip that proves the
    // daemon ran the ferry: the error text comes from the registry
    // inside the daemon process, not from this one.
    await expect(callDaemon(FIXTURE, 'swift/nope', FIXTURE, {})).rejects.toThrow(/Unknown tool/);
    expect(existsSync(socketPath(FIXTURE))).toBe(true);
  }, 60_000);

  it('reuses the running daemon on the next call', async () => {
    const before = existsSync(socketPath(FIXTURE));
    await expect(callDaemon(FIXTURE, 'swift/nope', FIXTURE, {})).rejects.toThrow(/Unknown tool/);
    expect(before).toBe(true);
  }, 60_000);

  /**
   * The hang this pins is invisible from inside a test runner, whose
   * own event loop is open regardless. Spawning the daemon leaves the
   * parent holding the child's stdout pipe, and unref() on the child
   * does not release it — so a CLI run would print its answer and then
   * never exit. Only a real subprocess that has to terminate shows it.
   */
  it('leaves the calling process free to exit', async () => {
    // Must unlink first: connecting to an already-running daemon never
    // reaches the spawn path, and the handle only leaks when spawning.
    const script = [
      `const { unlink } = await import('node:fs/promises');`,
      `const { callDaemon } = await import(${JSON.stringify(path.join(import.meta.dirname, 'client.ts'))});`,
      `const { socketPath } = await import(${JSON.stringify(path.join(import.meta.dirname, 'socket.ts'))});`,
      `await unlink(socketPath(${JSON.stringify(FIXTURE)})).catch(() => {});`,
      `await callDaemon(${JSON.stringify(FIXTURE)}, 'swift/nope', ${JSON.stringify(FIXTURE)}, {}).catch(() => {});`,
    ].join('\n');
    await expect(
      run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        timeout: 30_000,
      }),
    ).resolves.toBeDefined();
  }, 60_000);

  /**
   * The client unlinks a socket it cannot connect to and spawns a
   * replacement. Without this check the displaced daemon would hold a
   * listening handle nobody can reach for its whole idle timeout —
   * which happens on crash recovery and on every version bump, and
   * accumulated ten stray processes over one run of this suite.
   */
  it('exits once its socket file is gone, rather than lingering unreachable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sx-swift-daemon-'));
    await writeFile(path.join(root, 'Package.swift'), '// swift-tools-version:6.0\n', 'utf8');
    const child = spawn(process.execPath, ['--import', 'tsx', SERVE, root], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, STATIC_X_SWIFT_REACHABILITY_MS: '150' },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          if (chunk.includes('ready')) resolve();
        });
        child.once('exit', () => reject(new Error('exited before ready')));
      });
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      await unlink(socketPath(root));
      await expect(exited).resolves.not.toBeUndefined();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
