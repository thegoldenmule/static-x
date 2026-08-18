import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function packageVersion(): string {
  try {
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0';
  } catch {
    return '0';
  }
}

/** Where daemon sockets live. User-owned, mode 0700. */
export function socketDir(): string {
  return path.join(os.homedir(), '.cache', 'static-x', 'swift');
}

/**
 * One socket per version per project root.
 *
 * The version is in the name so an upgraded static-x can never talk to
 * a daemon running older code: it simply does not find one, spawns its
 * own, and the stale daemon idles out. That is cheaper and far more
 * reliable than negotiating a protocol version at connect time.
 *
 * macOS caps a unix socket path near 104 bytes, so the root is hashed
 * rather than embedded.
 */
export function socketPath(rootPath: string): string {
  const key = createHash('sha256').update(path.resolve(rootPath)).digest('hex').slice(0, 16);
  return path.join(socketDir(), `${packageVersion()}-${key}.sock`);
}
