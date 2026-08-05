import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from './run.js';

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/basic-ts');

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l) };
  return { out, err, io };
}

describe('runCli', () => {
  it('runs a tool end-to-end and reports findings as JSON', async () => {
    const { out, io } = capture();
    const code = await runCli(['ts/comments/long', '--project', FIXTURE], io);
    expect(code).toBe(1);
    const findings = JSON.parse(out.join('\n')) as { file: string; code: string }[];
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'comment.long' });
    expect(findings[0]?.file.endsWith('math.ts')).toBe(true);
  });

  it('exits 0 when there are no findings', async () => {
    const { out, io } = capture();
    const code = await runCli(
      ['ts/comments/long', '--project', FIXTURE, '--input', '{"maxLines": 50}'],
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual([]);
  });

  it('exits 2 with usage on missing arguments', async () => {
    const { err, io } = capture();
    expect(await runCli([], io)).toBe(2);
    expect(err.join('\n')).toMatch(/Usage: static-x/);
    expect(err.join('\n')).toMatch(/ts\/comments\/long/);
  });

  it('exits 2 on invalid JSON input and unknown tools', async () => {
    const { io } = capture();
    expect(await runCli(['ts/comments/long', '--project', FIXTURE, '--input', '{'], io)).toBe(2);
    expect(await runCli(['ts/nope/nope', '--project', FIXTURE], io)).toBe(2);
  });
});
