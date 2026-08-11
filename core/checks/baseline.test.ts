import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Finding } from '../tool/index.js';
import {
  BASELINE_FILENAME,
  fingerprint,
  loadBaseline,
  notInBaseline,
  writeBaseline,
} from './baseline.js';

const ROOT = path.resolve('/repo');

function finding(overrides: Partial<Finding> & { data?: Record<string, unknown> } = {}): Finding {
  return {
    file: path.join(ROOT, 'src/a.ts'),
    range: { start: { line: 4, character: 0 }, end: { line: 4, character: 9 } },
    code: 'types.assertion',
    message: 'assertion',
    severity: 'info',
    ...overrides,
  };
}

const temps: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'static-x-baseline-'));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('fingerprint', () => {
  it('ignores position, so code moving does not forget a baselined finding', () => {
    const moved = finding({ range: { start: { line: 90, character: 3 }, end: { line: 90, character: 8 } } });
    expect(fingerprint(moved, ROOT)).toBe(fingerprint(finding(), ROOT));
  });

  it('keys on data.name when the tool provides one', () => {
    expect(fingerprint(finding({ data: { name: 'Widget' } }), ROOT)).toBe(
      'src/a.ts|types.assertion|Widget',
    );
  });

  it('falls back to the message with numbers collapsed', () => {
    // dupes and cycles interpolate peer positions into their prose; a
    // line shift there must not mint a new fingerprint.
    const before = finding({ message: 'duplicate of a.ts:231' });
    const after = finding({ message: 'duplicate of a.ts:245' });
    expect(fingerprint(before, ROOT)).toBe(fingerprint(after, ROOT));
  });

  it('separates findings by file and code', () => {
    expect(fingerprint(finding({ code: 'types.non-null' }), ROOT)).not.toBe(
      fingerprint(finding(), ROOT),
    );
    expect(fingerprint(finding({ file: path.join(ROOT, 'src/b.ts') }), ROOT)).not.toBe(
      fingerprint(finding(), ROOT),
    );
  });
});

describe('notInBaseline', () => {
  it('counts occurrences, so a third of something baselined twice is new', () => {
    const baseline = new Map([['src/a.ts|types.assertion|assertion', 2]]);
    const three = [finding(), finding(), finding()];
    expect(notInBaseline(three, baseline, ROOT)).toHaveLength(1);
  });

  it('keeps everything when the baseline is empty', () => {
    expect(notInBaseline([finding()], new Map(), ROOT)).toHaveLength(1);
  });

  it('keeps nothing when the baseline covers it', () => {
    const baseline = new Map([['src/a.ts|types.assertion|assertion', 1]]);
    expect(notInBaseline([finding()], baseline, ROOT)).toEqual([]);
  });
});

describe('writeBaseline / loadBaseline', () => {
  it('round-trips a tally, sorted for a readable diff', async () => {
    const root = await tempRoot();
    const findings = [
      finding({ file: path.join(root, 'src/z.ts'), data: { name: 'Z' } }),
      finding({ file: path.join(root, 'src/a.ts'), data: { name: 'A' } }),
      finding({ file: path.join(root, 'src/a.ts'), data: { name: 'A' } }),
    ];
    const written = await writeBaseline(root, findings);
    expect(written.entries).toBe(2);

    const text = await readFile(path.join(root, BASELINE_FILENAME), 'utf8');
    expect(Object.keys((JSON.parse(text) as { findings: Record<string, number> }).findings)).toEqual([
      'src/a.ts|types.assertion|A',
      'src/z.ts|types.assertion|Z',
    ]);

    const loaded = await loadBaseline(root);
    expect(loaded?.get('src/a.ts|types.assertion|A')).toBe(2);
  });

  it('returns undefined when the project has no baseline', async () => {
    expect(await loadBaseline(await tempRoot())).toBeUndefined();
  });

  it('rejects a corrupt baseline rather than silently gating on everything', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, BASELINE_FILENAME), '{ not json', 'utf8');
    await expect(loadBaseline(root)).rejects.toThrow(/Invalid JSON/);

    await writeFile(path.join(root, BASELINE_FILENAME), '{"version":1}', 'utf8');
    await expect(loadBaseline(root)).rejects.toThrow(/expected a "findings" object/);
  });
});
