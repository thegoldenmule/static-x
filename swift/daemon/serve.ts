import { existsSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { mkdir, unlink } from 'node:fs/promises';
import { Ferry } from '../../core/ferry/index.js';
import { SwiftProjectSession } from '../project/index.js';
import { SWIFT_SOURCE_EXTENSIONS } from '../project/index.js';
import { createSwiftRegistry } from '../registry.js';
import {
  decode,
  encode,
  IDLE_TIMEOUT_MS,
  REACHABILITY_INTERVAL_MS,
  type DaemonRequest,
} from './protocol.js';
import { socketDir, socketPath } from './socket.js';

/**
 * The background process. Hosts one core/ferry, so config application,
 * `files` scoping and per-root serialization are the same code the
 * in-process path runs — a daemon that reimplemented dispatch would be
 * a second set of semantics to keep in step.
 */
export async function serve(rootPath: string): Promise<void> {
  const ferry = new Ferry(
    createSwiftRegistry(),
    (root: string) => SwiftProjectSession.open(root),
    SWIFT_SOURCE_EXTENSIONS,
  );

  const file = socketPath(rootPath);
  let idle: NodeJS.Timeout | undefined;
  const server = createServer();
  const shutdown = (): void => {
    server.close();
    void ferry.dispose().finally(() => process.exit(0));
  };
  // A developer who ran one command should not be left holding a
  // process. Restarting costs 0.3s, so idling out is nearly free.
  const resetIdle = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(shutdown, IDLE_TIMEOUT_MS);
    idle.unref();
  };

  server.on('connection', (socket: Socket) => {
    resetIdle();
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let messages: unknown[];
      try {
        ({ messages, rest: buffer } = decode(buffer));
      } catch {
        socket.end();
        return;
      }
      for (const message of messages) {
        const request = message as DaemonRequest;
        if (request.shutdown) {
          socket.end(encode({ id: request.id, ok: true, result: null }), () => {
            void unlink(file).catch(() => undefined);
            shutdown();
          });
          continue;
        }
        void ferry
          .call(request.tool, request.projectRoot, request.input)
          .then(
            (result) => ({ id: request.id, ok: true as const, result }),
            (error: unknown) => ({
              id: request.id,
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
            }),
          )
          .then((response) => {
            resetIdle();
            socket.write(encode(response));
          });
      }
    });
    socket.on('error', () => socket.destroy());
  });

  await mkdir(socketDir(), { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, resolve);
  });
  /**
   * A daemon whose socket file is gone is one nobody can reach: the
   * client unlinks a socket it cannot connect to and spawns a
   * replacement, and without this the displaced daemon would sit on a
   * listening handle for its whole idle timeout. That happens on crash
   * recovery and on every version bump, so it is not a corner case.
   */
  const interval = Number(process.env['STATIC_X_SWIFT_REACHABILITY_MS'] ?? '') ||
    REACHABILITY_INTERVAL_MS;
  const reachable = setInterval(() => {
    if (!existsSync(file)) shutdown();
  }, interval);
  reachable.unref();

  resetIdle();
  // The client waits for this line rather than polling for the socket
  // file, which exists a moment before it is accepting.
  process.stdout.write('ready\n');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void unlink(file).catch(() => undefined);
      shutdown();
    });
  }
}

if (process.argv[2]) {
  serve(process.argv[2]).catch(() => process.exit(1));
}
