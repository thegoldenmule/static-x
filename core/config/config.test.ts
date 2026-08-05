import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Finding } from '../tool/index.js';
import {
  filterFindings,
  isFindingArray,
  loadProjectConfig,
  toolConfigFor,
} from './config.js';

function finding(overrides: Partial<Finding> & { data?: Record<string, unknown> }): Finding {
  return {
    file: '/p/a.ts',
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    code: 'comment.stale-ref',
    message: 'm',
    severity: 'warning',
    ...overrides,
  };
}

describe('toolConfigFor', () => {
  const config = {
    ts: { comments: { 'stale-refs': { ignore: ['ts_rank'] } } },
  };

  it('walks the tree along tool path segments', () => {
    expect(toolConfigFor(config, 'ts/comments/stale-refs')).toEqual({ ignore: ['ts_rank'] });
  });

  it('returns undefined for unconfigured tools and missing config', () => {
    expect(toolConfigFor(config, 'ts/comments/long')).toBeUndefined();
    expect(toolConfigFor(config, 'ts/refactors/rename')).toBeUndefined();
    expect(toolConfigFor(undefined, 'ts/comments/long')).toBeUndefined();
  });
});

describe('filterFindings', () => {
  it('drops ignored names', () => {
    const kept = filterFindings(
      [finding({ data: { name: 'ts_rank' } }), finding({ data: { name: 'realBug' } })],
      { ignore: ['ts_rank'] },
    );
    expect(kept.map((f) => f.data?.name)).toEqual(['realBug']);
  });

  it('filters by minimum severity', () => {
    const kept = filterFindings(
      [finding({ severity: 'info' }), finding({ severity: 'warning' })],
      { minSeverity: 'warning' },
    );
    expect(kept.map((f) => f.severity)).toEqual(['warning']);
  });

  it('filters by minimum confidence, passing findings without one', () => {
    const kept = filterFindings(
      [
        finding({ data: { name: 'a', confidence: 'low' } }),
        finding({ data: { name: 'b', confidence: 'high' } }),
        finding({ data: { name: 'c' } }),
      ],
      { minConfidence: 'medium' },
    );
    expect(kept.map((f) => f.data?.name)).toEqual(['b', 'c']);
  });
});

describe('isFindingArray', () => {
  it('accepts finding lists and rejects other tool output', () => {
    expect(isFindingArray([finding({})])).toBe(true);
    expect(isFindingArray([])).toBe(true);
    expect(isFindingArray({ applied: false, edit: { changes: {} } })).toBe(false);
    expect(isFindingArray([{ notAFinding: true }])).toBe(false);
  });
});

describe('loadProjectConfig', () => {
  it('returns undefined when no config file exists', async () => {
    expect(await loadProjectConfig(os.tmpdir())).toBeUndefined();
  });

  it('loads valid config and rejects invalid JSON', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'static-x-config-'));
    try {
      await writeFile(path.join(dir, 'static-x.json'), '{"ts": {}}');
      expect(await loadProjectConfig(dir)).toEqual({ ts: {} });
      await writeFile(path.join(dir, 'static-x.json'), '{oops');
      await expect(loadProjectConfig(dir)).rejects.toThrow(/Invalid JSON/);
      await writeFile(path.join(dir, 'static-x.json'), '[1]');
      await expect(loadProjectConfig(dir)).rejects.toThrow(/must be a JSON object/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
