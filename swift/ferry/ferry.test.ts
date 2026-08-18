import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FINDINGS_ARRAY_SCHEMA, ToolRegistry, type Tool } from '../../core/tool/index.js';
import type { SwiftProjectSession } from '../project/index.js';
import { SwiftFerry } from './ferry.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/basic-swift');

/** Reports one finding per target file, so scoping is observable. */
const listFiles: Tool<Record<string, never>, unknown, SwiftProjectSession> = {
  name: 'swift/test/list',
  description: 'test tool',
  inputSchema: { type: 'object' },
  outputSchema: FINDINGS_ARRAY_SCHEMA,
  run: (session) =>
    Promise.resolve(
      session.targetFiles().map((file) => ({
        file,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        code: 'test.file',
        message: path.basename(file),
        severity: 'info' as const,
      })),
    ),
};

function ferry(options: { daemon?: boolean } = {}) {
  const registry = new ToolRegistry();
  registry.register(listFiles);
  return new SwiftFerry(registry, options);
}

describe('SwiftFerry', () => {
  // Contacting the daemon is what starts a language server, so a commit
  // naming no .swift file must be answered before that happens.
  it('answers a scope naming nothing Swift without touching the daemon', async () => {
    const f = ferry();
    await expect(f.call('swift/test/list', FIXTURE, { files: ['README.md', 'a.ts'] })).resolves.toEqual(
      [],
    );
    await f.dispose();
  });

  // The daemon is a latency optimisation. If it were also a new way for
  // a tool to fail, it would not be worth having.
  it('falls back in-process when the daemon cannot be reached', async () => {
    const f = ferry({ daemon: true });
    // A root with no Swift project makes any daemon spawn fail fast,
    // and the in-process path then reports the real binding error.
    await expect(f.call('swift/test/list', path.resolve(import.meta.dirname), {})).rejects.toThrow(
      /No Swift project found under/,
    );
    await f.dispose();
  });

  it('produces the same answer with the daemon disabled', async () => {
    const f = ferry({ daemon: false });
    const findings = (await f.call('swift/test/list', FIXTURE, {})) as { message: string }[];
    expect(findings.map((finding) => finding.message).sort()).toEqual([
      'BasicTests.swift',
      'Greeter.swift',
      'License.swift',
      'Literals.swift',
      'Marks.swift',
      'Math.swift',
      'Notes.swift',
      'Strings.swift',
    ]);
    await f.dispose();
  });

  it('honours a scope that names one file', async () => {
    const f = ferry({ daemon: false });
    const findings = (await f.call('swift/test/list', FIXTURE, {
      files: ['Sources/Basic/Math.swift'],
    })) as { message: string }[];
    expect(findings.map((finding) => finding.message)).toEqual(['Math.swift']);
    await f.dispose();
  });
});
