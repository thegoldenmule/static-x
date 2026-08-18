import { describe, expect, it } from 'vitest';
import { toBlocks } from './blocks.js';
import { lineStartsOf, positionAt } from '../text/index.js';
import { findLongComments } from './long.js';
import { findLlmTells } from './tells/tells.js';
import type { CommentFile, CommentRange } from './types.js';

/** A doubled slash never opens a comment here — the ranges are given. */
const SLASHES = /^\/\/(?:\s*(?:@ts-\w|eslint-))/;
const LICENSE = /\b(?:copyright|licen[cs]e|spdx)\b|\(c\)/i;

/**
 * Build a CommentFile by scanning for `//` and block comments the naive
 * way. Safe here and only here: these fixtures hold no strings, which is
 * exactly the hazard a real pack's range provider exists to avoid.
 */
function file(text: string, docPrefix = '/**'): CommentFile {
  const ranges: CommentRange[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      ranges.push({
        pos: i,
        end: end === -1 ? text.length : end,
        line: true,
        doc: docPrefix === '///' && text.startsWith('///', i),
      });
      i = end === -1 ? text.length : end;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      ranges.push({ pos: i, end: stop, line: false, doc: text.startsWith('/**', i) });
      i = stop - 1;
    }
  }
  const firstCode = text.search(/^\S/m);
  return {
    file: '/p/a.txt',
    text,
    lineStarts: lineStartsOf(text),
    ranges,
    firstCodeOffset: ranges.length > 0 ? (ranges.at(-1)?.end ?? 0) : firstCode,
  };
}

describe('lineStartsOf / positionAt', () => {
  it('places every offset on the line that contains it', () => {
    const text = 'a\nbb\n\nccc';
    const starts = lineStartsOf(text);
    expect(starts).toEqual([0, 2, 5, 6]);
    expect(positionAt(starts, 0)).toEqual({ line: 0, character: 0 });
    expect(positionAt(starts, 3)).toEqual({ line: 1, character: 1 });
    expect(positionAt(starts, 5)).toEqual({ line: 2, character: 0 });
    expect(positionAt(starts, 8)).toEqual({ line: 3, character: 2 });
  });

  it('counts a CRLF break once, so the CR belongs to the line it ends', () => {
    const starts = lineStartsOf('a\r\nb');
    expect(starts).toEqual([0, 3]);
    expect(positionAt(starts, 1)).toEqual({ line: 0, character: 1 });
    expect(positionAt(starts, 3)).toEqual({ line: 1, character: 0 });
  });
});

describe('toBlocks', () => {
  it('merges consecutive whole-line comments into one block', () => {
    const blocks = toBlocks(file('// one\n// two\n// three\ncode\n'), SLASHES);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'line-block', startLine: 0, endLine: 2 });
  });

  it('breaks a run on a blank line', () => {
    const blocks = toBlocks(file('// one\n\n// two\n'), SLASHES);
    expect(blocks.map((b) => b.startLine)).toEqual([0, 2]);
  });

  it('breaks a run on intervening code', () => {
    const blocks = toBlocks(file('// one\ncode\n// two\n'), SLASHES);
    expect(blocks.map((b) => b.startLine)).toEqual([0, 2]);
  });

  it('drops a directive and splits the block it sits in', () => {
    const blocks = toBlocks(file('// one\n// @ts-expect-error\n// two\n'), SLASHES);
    expect(blocks.map((b) => b.startLine)).toEqual([0, 2]);
  });

  it('never merges onto a trailing comment, which has code before it', () => {
    const blocks = toBlocks(file('code // trailing\n// after\n'), SLASHES);
    expect(blocks.map((b) => b.kind)).toEqual(['block', 'line-block']);
  });

  it('leaves a block comment standing alone', () => {
    const blocks = toBlocks(file('/* one */\n/* two */\n'), SLASHES);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.kind === 'block')).toBe(true);
  });

  // The rule Swift needs and TypeScript cannot exercise: `///` and `//`
  // are both line comments there, and merging a DocC summary into an
  // adjacent note would hand the narration check a comment that is
  // supposed to name what it documents.
  it('never merges a doc run with a non-doc run', () => {
    const blocks = toBlocks(file('/// doc\n// note\n', '///'), SLASHES);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.doc)).toEqual([true, false]);
  });

  it('merges a doc run with itself', () => {
    const blocks = toBlocks(file('/// one\n/// two\n', '///'), SLASHES);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ doc: true, endLine: 1 });
  });
});

describe('findLongComments', () => {
  const long = (text: string, options = {}) => {
    const f = file(text);
    return findLongComments(f, toBlocks(f, SLASHES), { license: LICENSE, ...options });
  };

  it('flags a run that exceeds the line limit', () => {
    const findings = long(`${'// filler\n'.repeat(12)}code\n`, { maxLines: 10 });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('comment.long');
    expect(findings[0]?.data).toMatchObject({ lines: 12, maxLines: 10, kind: 'line-block' });
    expect(findings[0]?.range.start).toEqual({ line: 0, character: 0 });
  });

  it('flags a block that exceeds the character limit within the line limit', () => {
    const findings = long(`/* ${'x'.repeat(900)} */\ncode\n`, { maxChars: 800 });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('characters');
    expect(findings[0]?.data).toMatchObject({ kind: 'block' });
  });

  it('says nothing about a block under both limits', () => {
    expect(long('// short\ncode\n')).toEqual([]);
  });

  it('exempts a long license header above the first code', () => {
    const header = `// Copyright 2026 Someone\n${'// terms\n'.repeat(14)}`;
    expect(long(`${header}code\n`, { maxLines: 10 })).toEqual([]);
  });

  it('flags a same-shaped header that is not a license', () => {
    const header = `// Overview of this module\n${'// prose\n'.repeat(14)}`;
    expect(long(`${header}code\n`, { maxLines: 10 })).toHaveLength(1);
  });

  it('flattens the comment head into the ignore key', () => {
    const findings = long(`${'// filler\n'.repeat(12)}code\n`, { maxLines: 10 });
    const name = findings[0]?.data?.['name'];
    expect(name).toBe('// filler '.repeat(6));
    expect(name).toHaveLength(60);
  });
});

describe('findLlmTells', () => {
  const contentOf = (raw: string) =>
    raw
      .replace(/^\/\*\*?/, '')
      .replace(/\*\/$/, '')
      .split('\n')
      .map((line) => line.replace(/^\s*(?:\/\/|\*)?\s?/, ''))
      .join('\n')
      .trim();

  const tells = (text: string, options = {}) => {
    const f = file(text, '///');
    return findLlmTells(f, toBlocks(f, SLASHES), {
      contentOf,
      narratable: (block) => block.kind === 'line-block' && !block.doc,
      ...options,
    });
  };

  it('flags filler phrasing and reports which patterns matched', () => {
    const findings = tells("// It's worth noting we leverage a seamless approach.\ncode\n");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data).toMatchObject({
      score: 3,
      matches: ['worth-noting', 'leverage', 'seamless'],
    });
  });

  it('flags change-log prose only when the comment opens with it', () => {
    expect(tells('// Updated the parser to handle escapes.\ncode\n')).toHaveLength(1);
    expect(tells('// The parser updated its state here.\ncode\n')).toEqual([]);
  });

  it('flags a comment that restates the line below it', () => {
    const findings = tells('// Return the total count\nreturn totalCount;\n');
    expect(findings[0]?.data).toMatchObject({ matches: ['narration'] });
  });

  it('says nothing about a comment that adds what the code cannot', () => {
    expect(tells('// tsserver answers before project load, and those answers are wrong\ncode\n')).toEqual([]);
  });

  it('respects minScore, so weak tells need company', () => {
    const source = '// This robust module is designed to help.\ncode\n';
    expect(tells(source)).toHaveLength(1);
    expect(tells(source, { minScore: 2 })).toEqual([]);
  });

  // A doc comment naming its own declaration is a summary, not filler.
  it('never counts a doc block as narration', () => {
    expect(tells('/// Return the total count\nreturn totalCount;\n')).toEqual([]);
  });
});
