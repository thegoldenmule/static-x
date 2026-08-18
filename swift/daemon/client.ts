import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode, type DaemonResponse } from './protocol.js';
import { socketPath } from './socket.js';

const SERVE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'serve.ts');
const CONNECT_TIMEOUT_MS = 15_000;

function connect(file: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(file);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/**
 * Start a daemon and wait for it to say it is listening. Waiting on the
 * banner rather than polling for the socket file matters: the file
 * exists for a moment before the server is accepting on it, so a client
 * that polled would connect-and-fail on a cold start.
 */
async function spawnDaemon(rootPath: string): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', SERVE, rootPath], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  child.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('daemon did not report ready')),
        CONNECT_TIMEOUT_MS,
      );
      timer.unref();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (chunk.includes('ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('daemon exited before reporting ready')));
    });
  } finally {
    // unref() on the child is not enough: the stdout pipe we read the
    // banner from is its own handle, and leaving it open holds this
    // process's event loop open forever. A CLI run that started a
    // daemon would print its answer and then simply never exit.
    child.stdout.destroy();
    child.removeAllListeners();
  }
}

/**
 * Connect to this root's daemon, starting one if there is none.
 *
 * A stale socket left by a crashed daemon refuses the connection, so it
 * is unlinked and respawned. Two invocations racing to start one both
 * try to listen; the loser's bind fails and it connects to the winner,
 * which is why the retry is a plain second attempt rather than a lock.
 */
async function connectOrSpawn(rootPath: string): Promise<Socket> {
  const file = socketPath(rootPath);
  try {
    return await connect(file);
  } catch {
    await unlink(file).catch(() => undefined);
  }
  await spawnDaemon(rootPath).catch(() => undefined);
  return connect(file);
}

/** One call over the socket. */
export async function callDaemon(
  rootPath: string,
  tool: string,
  projectRoot: string,
  input: unknown,
  shutdown = false,
): Promise<unknown> {
  const socket = await connectOrSpawn(rootPath);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let messages: unknown[];
        try {
          ({ messages, rest: buffer } = decode(buffer));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        for (const message of messages) {
          const response = message as DaemonResponse;
          if (response.ok) resolve(response.result);
          else reject(new Error(response.error));
        }
      });
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('daemon closed the connection')));
      socket.write(encode({ id: 1, tool, projectRoot, input, shutdown }));
    });
  } finally {
    socket.destroy();
  }
}
