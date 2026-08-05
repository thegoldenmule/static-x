import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Finding } from '../../core/tool/index.js';
import { createTsRegistry } from '../registry.js';
import { TsFerry } from './ferry.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/basic-ts');

describe('TsFerry with a project static-x.json', () => {
  let dir: string;
  const ferry = new TsFerry(createTsRegistry());

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'static-x-ferry-config-'));
    await cp(FIXTURE, dir, { recursive: true });
    await writeFile(
      path.join(dir, 'static-x.json'),
      JSON.stringify({
        ts: {
          comments: {
            'stale-refs': { ignore: ['LegacyGreeter'], minConfidence: 'medium' },
            long: { input: { maxLines: 5 } },
          },
        },
      }),
    );
  });
  afterAll(async () => {
    await ferry.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('drops ignored names from finding output', async () => {
    const findings = (await ferry.call('ts/comments/stale-refs', dir, {})) as Finding[];
    const names = findings.map((f) => f.data?.name);
    expect(names).not.toContain('LegacyGreeter');
    expect(names).toContain('formatSalutation');
    expect(names).toContain('minuend');
  });

  it('uses config input as defaults', async () => {
    const findings = (await ferry.call('ts/comments/long', dir, {})) as Finding[];
    const files = findings.map((f) => path.basename(f.file)).sort();
    expect(files).toEqual(['greeter.ts', 'math.ts']); // maxLines 5 from config
  });

  it('lets explicit input override config input', async () => {
    const findings = (await ferry.call('ts/comments/long', dir, { maxLines: 50 })) as Finding[];
    expect(findings).toEqual([]);
  });

  it('leaves unconfigured tools and non-finding output untouched', async () => {
    const result = (await ferry.call('ts/refactors/rename', dir, {
      newName: 'greetOne',
      symbol: 'greet',
    })) as { applied: boolean };
    expect(result.applied).toBe(false);
  });

  it('surfaces a clear error for malformed config', async () => {
    const broken = await mkdtemp(path.join(os.tmpdir(), 'static-x-ferry-broken-'));
    const brokenFerry = new TsFerry(createTsRegistry());
    try {
      await cp(FIXTURE, broken, { recursive: true });
      await writeFile(path.join(broken, 'static-x.json'), '{nope');
      await expect(brokenFerry.call('ts/comments/long', broken, {})).rejects.toThrow(
        /Invalid JSON/,
      );
    } finally {
      await brokenFerry.dispose();
      await rm(broken, { recursive: true, force: true });
    }
  });
});
