import { describe, expect, it } from 'vitest';
import { extractCandidates, looksLikeCode } from './extract.js';
import { parametersFor } from './parameters.js';
import { lineStartsOf } from '../../../core/text/index.js';
import type { CommentBlock } from '../../../core/comments/index.js';

describe('extractCandidates', () => {
  const named = (comment: string) =>
    Object.fromEntries(extractCandidates(comment).map((c) => [c.raw, c.source]));

  it('reads DocC tags, links and code spans, each as its own source', () => {
    expect(
      named('- Parameter userName: who\n``Greeter/salute(for:)`` and `totalCount` and httpClient'),
    ).toEqual({
      userName: 'param-tag',
      // The selector is reduced to plain call shape, keeping the fact
      // that it is a call.
      'Greeter/salute()': 'doc-link',
      totalCount: 'code-span',
      httpClient: 'bare',
    });
  });

  it('reads a - Parameters: sublist and stops at the dedent', () => {
    const found = named(
      '- Parameters:\n    - first: one\n    - second: two\n- Returns: nothing\n',
    );
    expect(found['first']).toBe('param-tag');
    expect(found['second']).toBe('param-tag');
    expect(found['Returns']).toBeUndefined();
  });

  // Without this pass one corpus reports 502 unresolved bare tokens,
  // dominated by the scheme and the host.
  it('blanks URLs before anything else looks at them', () => {
    expect(named('see https://github.com/apple/swift and mailto:a@b.dev')).toEqual({});
  });

  it('keeps a filename whole rather than splitting it into fragments', () => {
    const found = extractCandidates('see `Math.swift` and Legacy-Utils.swift');
    expect(found.filter((c) => c.isFile).map((c) => c.raw)).toEqual([
      'Math.swift',
      'Legacy-Utils.swift',
    ]);
  });

  /**
   * `.hotseat/hotseat.json` is a path relative to the user's home, not
   * to the repository, and it was the single largest false-positive
   * family the first measured run produced.
   */
  it('ignores paths the project could not be expected to resolve', () => {
    const found = extractCandidates('`~/.config/a.json` `/etc/b.json` `.hotseat/c.json`');
    expect(found.filter((c) => c.isFile)).toEqual([]);
  });

  it('reports where in the comment each reference sits', () => {
    const [only] = extractCandidates('the `staleThing` here');
    expect(only?.raw).toBe('staleThing');
    expect('the `staleThing` here'.slice(only!.offset, only!.offset + only!.raw.length)).toBe(
      'staleThing',
    );
  });

  it('resolves a chain if any segment does, so it keeps every segment', () => {
    const [only] = extractCandidates('`URL.absoluteString`');
    expect(only?.segments).toEqual(['URL', 'absoluteString']);
  });
});

describe('looksLikeCode', () => {
  it('accepts a case hump, an underscore, a dot chain, a leading dot, or parens', () => {
    for (const raw of ['totalCount', 'total_count', 'URL.host', '.finish', 'reload()']) {
      expect(looksLikeCode(raw)).toBe(true);
    }
  });

  it('rejects ordinary prose', () => {
    for (const raw of ['Note', 'the', 'Returns']) expect(looksLikeCode(raw)).toBe(false);
  });
});

describe('parametersFor', () => {
  const block = (endLine: number): CommentBlock => ({
    pos: 0,
    end: 0,
    startLine: 0,
    endLine,
    kind: 'line-block',
    doc: true,
  });
  const read = (source: string, endLine: number) =>
    parametersFor(source, lineStartsOf(source), block(endLine));

  /**
   * Swift declares an argument label and an internal name, and a doc
   * comment naming either is correct. Labels and names differ on 6.8%
   * to 25% of documented parameters across the measured corpora, so
   * requiring one would false-positive on up to a quarter of them.
   */
  it('accepts the argument label and the internal name alike', () => {
    const found = read('/// doc\nfunc greet(for name: String, _ loudly: Bool) {}\n', 0);
    expect(found?.accepted.has('for')).toBe(true);
    expect(found?.accepted.has('name')).toBe(true);
    expect(found?.accepted.has('loudly')).toBe(true);
    // `_` is not a name anyone can write in a doc tag.
    expect(found?.accepted.has('_')).toBe(false);
  });

  it('skips attributes and modifiers between the comment and the declaration', () => {
    const found = read('/// doc\n@MainActor\npublic func run(step: Int) {}\n', 0);
    expect(found?.display).toEqual(['step']);
  });

  it('reads a declaration with no parameters', () => {
    expect(read('/// doc\nfunc run() {}\n', 0)?.display).toEqual([]);
  });

  // A wrongly reported tag is a wrong edit, so anything unreadable is
  // skipped rather than guessed at.
  it('refuses a shape it cannot read confidently', () => {
    expect(read('/// doc\nlet x = 1\n', 0)).toBeUndefined();
    expect(read('/// doc\nfunc f(a: String = "(")\n', 0)).toBeUndefined();
  });

  it('handles generics and closures without splitting on their commas', () => {
    const found = read('/// doc\nfunc f(map: [String: Int], done: (Int, Int) -> Void) {}\n', 0);
    expect(found?.display).toEqual(['map', 'done']);
  });
});
