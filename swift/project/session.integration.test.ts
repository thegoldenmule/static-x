import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SwiftProjectSession } from './session.js';

/**
 * Against the real sourcekit-lsp. These assertions are the pack's
 * foundation: if the handshake or the file sets are wrong, every tool
 * built on them is wrong in a way its own unit tests cannot see.
 */
const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/basic-swift');

describe('SwiftProjectSession', () => {
  const session = SwiftProjectSession.open(FIXTURE);
  afterAll(async () => {
    await session.dispose();
  });

  it('binds the fixture as a SwiftPM project', () => {
    expect(session.language).toBe('swift');
    expect(session.binding.kind).toBe('swiftpm');
    expect(session.binding.degraded).toBe(false);
    expect(path.basename(session.binding.configPath)).toBe('Package.swift');
  });

  it('refuses to exist unbound', () => {
    expect(() => SwiftProjectSession.open(path.resolve(import.meta.dirname))).toThrow(
      /No Swift project found under/,
    );
  });

  // Manifests are .swift files in no target; a finding in one is noise.
  it('excludes the package manifest from every file set', () => {
    for (const set of [session.projectFiles(), session.sourceFiles(), session.compilationFiles()]) {
      expect(set.some((file) => path.basename(file) === 'Package.swift')).toBe(false);
    }
  });

  it('reports in sources and tests, which are both the author’s code', () => {
    const names = session.sourceFiles().map((file) => path.basename(file));
    expect(names).toContain('Math.swift');
    expect(names).toContain('Strings.swift');
    expect(names).toContain('BasicTests.swift');
  });

  it('completes the handshake with the capabilities the tools need', async () => {
    const lsp = await session.lsp();
    expect(lsp).toBeDefined();
  });

  // The property the whole pack rests on: comment ranges come back from
  // a project that has never been built.
  it('answers semantic tokens without a build, and marks doc comments', async () => {
    const lsp = await session.lsp();
    const file = path.join(FIXTURE, 'Sources/Basic/Strings.swift');
    const uri = await lsp.openDocument(file, 'swift');
    const result = await lsp.request<{ data?: number[] } | null>(
      'textDocument/semanticTokens/full',
      { textDocument: { uri } },
    );

    expect(result?.data).toBeDefined();
    const data = result?.data ?? [];
    expect(data.length).toBeGreaterThan(0);
    // Token type 17 is `comment` in the legend this pack declares.
    const commentTokens = [];
    for (let i = 0; i < data.length; i += 5) {
      if (data[i + 3] === 17) commentTokens.push({ mods: data[i + 4] ?? 0 });
    }
    expect(commentTokens.length).toBe(8);
    // Bit 8 is `documentation`: the two /// lines, and nothing else.
    expect(commentTokens.filter((t) => (t.mods & (1 << 8)) !== 0)).toHaveLength(2);
  }, 60_000);
});
