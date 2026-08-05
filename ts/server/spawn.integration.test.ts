import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startTsServer } from './spawn.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/basic-ts');

describe('startTsServer', () => {
  it('spawns the server and completes the LSP handshake', { timeout: 30_000 }, async () => {
    const client = await startTsServer(FIXTURE);
    try {
      const uri = await client.openDocument(
        path.join(FIXTURE, 'src/index.ts'),
        'typescript',
      );
      expect(uri).toMatch(/^file:\/\/.*index\.ts$/);
    } finally {
      await client.shutdown();
    }
  });
});
