import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { LspClient } from '../../core/lsp/index.js';

const require = createRequire(import.meta.url);

function resolveServerCli(): string {
  const pkgJson = require.resolve('typescript-language-server/package.json');
  const pkg = require('typescript-language-server/package.json') as {
    bin: Record<string, string>;
  };
  const bin = pkg.bin['typescript-language-server'];
  if (!bin) {
    throw new Error('typescript-language-server package has no expected bin entry');
  }
  return path.join(path.dirname(pkgJson), bin);
}

export function spawnTsServer(): ChildProcess {
  return spawn(process.execPath, [resolveServerCli(), '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Spawn typescript-language-server and complete the LSP handshake. */
export async function startTsServer(rootPath: string): Promise<LspClient> {
  const client = new LspClient(spawnTsServer());
  try {
    const result = await client.initialize(rootPath);
    if (!result.capabilities.hoverProvider || !result.capabilities.renameProvider) {
      throw new Error('server is missing required capabilities (hover, rename)');
    }
  } catch (error) {
    await client.shutdown();
    const stderr = client.serverStderr.trim();
    throw new Error(
      `typescript-language-server failed to initialize for ${rootPath}` +
        (stderr ? `\nserver stderr:\n${stderr}` : ''),
      { cause: error },
    );
  }
  return client;
}
