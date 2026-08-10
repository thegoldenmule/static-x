import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from './run.js';

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/basic-ts');

function capture(stdin?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    cwd: FIXTURE,
    ...(stdin === undefined ? {} : { readStdin: () => Promise.resolve(stdin) }),
  };
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
    expect(await runCli(['ts/comments/long', '--project', FIXTURE, '--input', '[]'], io)).toBe(2);
    expect(await runCli(['ts/nope/nope', '--project', FIXTURE], io)).toBe(2);
  });

  describe('--files', () => {
    it('reports only on the named files', async () => {
      const { out, io } = capture();
      const code = await runCli(
        ['ts/comments/long', '--project', FIXTURE, '--files', 'src/math.ts'],
        io,
      );
      expect(code).toBe(1);
      expect((JSON.parse(out.join('\n')) as { file: string }[])).toHaveLength(1);

      const clean = capture();
      expect(
        await runCli(
          ['ts/comments/long', '--project', FIXTURE, '--files', 'src/greeter.ts'],
          clean.io,
        ),
      ).toBe(0);
      expect(JSON.parse(clean.out.join('\n'))).toEqual([]);
    });

    it('accepts the flag repeatedly and a list on stdin, as one scope', async () => {
      const { out, io } = capture('src/math.ts\nsrc/notes.ts\n');
      const code = await runCli(
        [
          'ts/comments/stale-refs',
          '--project',
          FIXTURE,
          '--files',
          'src/literals.ts',
          '--files-from',
          '-',
        ],
        io,
      );
      expect(code).toBe(1);
      const files = (JSON.parse(out.join('\n')) as { file: string }[]).map((f) =>
        path.basename(f.file),
      );
      expect(new Set(files)).toEqual(new Set(['literals.ts', 'math.ts']));
    });

    it('exits 0 without loading the project when the list names no source', async () => {
      const { out, io } = capture('README.md\0docs/plan.md\0');
      const code = await runCli(
        ['ts/comments/long', '--project', '/no/such/project', '--files-from', '-'],
        io,
      );
      expect(code).toBe(0);
      expect(JSON.parse(out.join('\n'))).toEqual([]);
    });

    it('exits 2 when the list file cannot be read, or the tool cannot be scoped', async () => {
      const missing = capture();
      expect(
        await runCli(
          ['ts/comments/long', '--project', FIXTURE, '--files-from', '/no/such/list.txt'],
          missing.io,
        ),
      ).toBe(2);
      expect(missing.err.join('\n')).toMatch(/--files-from/);

      const refactor = capture();
      expect(
        await runCli(
          [
            'ts/refactors/rename',
            '--project',
            FIXTURE,
            '--files',
            'src/math.ts',
            '--input',
            '{"symbol":"add","newName":"plus"}',
          ],
          refactor.io,
        ),
      ).toBe(2);
      expect(refactor.err.join('\n')).toMatch(/cannot be scoped/);
    });
  });

  describe('--format text', () => {
    it('prints one linkable line per finding, then a count', async () => {
      const { out, io } = capture();
      const code = await runCli(
        ['ts/comments/long', '--project', FIXTURE, '--format', 'text'],
        io,
      );
      expect(code).toBe(1);
      expect(out[0]).toMatch(/^src\/math\.ts:1:1 {2}info {2}comment\.long {2}Comment block spans/);
      expect(out.at(-1)).toBe('1 finding (1 info) in 1 file');
    });

    it('prints nothing when there are no findings', async () => {
      const { out, io } = capture();
      const code = await runCli(
        ['ts/comments/long', '--project', FIXTURE, '--format', 'text', '--input', '{"maxLines":50}'],
        io,
      );
      expect(code).toBe(0);
      expect(out).toEqual([]);
    });

    it('rejects an unknown format', async () => {
      const { err, io } = capture();
      expect(
        await runCli(['ts/comments/long', '--project', FIXTURE, '--format', 'yaml'], io),
      ).toBe(2);
      expect(err.join('\n')).toMatch(/--format must be json or text/);
    });
  });
});
