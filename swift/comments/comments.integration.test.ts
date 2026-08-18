import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Finding } from '../../core/tool/index.js';
import { SwiftProjectSession } from '../project/index.js';
import { swiftLlmTells } from './llm-tells/llm-tells.js';
import { swiftLongComments } from './long/long.js';
import { swiftStaleRefs } from './stale-refs/stale-refs.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/basic-swift');

const at = (findings: Finding[]) =>
  findings.map((f) => `${path.basename(f.file)}:${f.range.start.line}`).sort();

describe('the Swift comment family', () => {
  const session = SwiftProjectSession.open(FIXTURE);
  afterAll(async () => {
    await session.dispose();
  });

  describe('comments/long', () => {
    it('reports exactly the two over-threshold blocks', async () => {
      const findings = await swiftLongComments.run(session, {});
      expect(at(findings)).toEqual(['License.swift:15', 'Math.swift:0']);
    });

    /**
     * Both headers in License.swift are fourteen lines and both sit
     * above all the code. Only one is exempt, so the exemption is
     * reading what the block says rather than where it is — which is
     * the only thing that stops it degenerating into "skip the first
     * comment in every file".
     */
    it('exempts a license header by content, not by position', async () => {
      const findings = await swiftLongComments.run(session, {});
      const license = findings.filter((f) => path.basename(f.file) === 'License.swift');
      expect(license).toHaveLength(1);
      expect(license[0]?.range.start.line).toBe(15);
      expect(license[0]?.data).toMatchObject({ lines: 14 });
    });

    // 540 occurrences in one real project. Without the split, the two
    // runs in Marks.swift merge into one block over the threshold and
    // the tool invents a finding the source does not contain.
    it('lets // MARK: split a run that would otherwise be reportable', async () => {
      const findings = await swiftLongComments.run(session, {});
      expect(findings.some((f) => path.basename(f.file) === 'Marks.swift')).toBe(false);
    });

    it('carries the doc flag so a project can filter DocC blocks', async () => {
      const findings = await swiftLongComments.run(session, { maxLines: 3 });
      expect(findings.some((f) => f.data?.['doc'] === true)).toBe(true);
    });

    it('reports nothing in the all-resolves control', async () => {
      const findings = await swiftLongComments.run(session, {});
      expect(findings.some((f) => path.basename(f.file) === 'Notes.swift')).toBe(false);
    });
  });

  describe('comments/llm-tells', () => {
    it('reports the filler header and the narration, and nothing else', async () => {
      const findings = await swiftLlmTells.run(session, {});
      expect(at(findings)).toEqual(['Math.swift:0', 'Math.swift:26']);
    });

    /**
     * The one rule the port had to change. totalDocumented() is
     * byte-identical to total() except that its return comment is ///
     * rather than //. TypeScript gets this free because a doc comment
     * there is a block comment; in Swift both are line comments and
     * only the doc flag separates a DocC summary from a note.
     */
    it('never treats a DocC summary as narration', async () => {
      const findings = await swiftLlmTells.run(session, {});
      const narration = findings.filter((f) =>
        (f.data?.['matches'] as string[] | undefined)?.includes('narration'),
      );
      expect(narration).toHaveLength(1);
      expect(narration[0]?.range.start.line).toBe(26);
    });

    it('reports nothing in the all-resolves control', async () => {
      const findings = await swiftLlmTells.run(session, {});
      expect(findings.some((f) => path.basename(f.file) === 'Notes.swift')).toBe(false);
    });
  });

  /**
   * The property the pack rests on. A `//` inside a string literal, a
   * raw string, or an interpolation is a `string` token to the
   * compiler and can never reach these tools as a comment — which is
   * the entire reason there is no hand-written lexer here.
   */
  it('never mistakes comment-like text in a string for a comment', async () => {
    // "not a comment" appears three times in Strings.swift and every
    // one is inside a string literal — plain, raw, and after an
    // escaped quote. If any of them ever reaches a finding, the range
    // source has started fabricating comments and the whole family is
    // reporting on text that is not comments at all.
    for (const tool of [swiftLongComments, swiftLlmTells]) {
      const findings = await tool.run(session, { maxLines: 1, minScore: 0.5 });
      for (const finding of findings) {
        const name = finding.data?.['name'];
        expect(typeof name === 'string' ? name : '').not.toContain('not a comment');
      }
    }
  });

  it('finds the real comments in that same file, so the check above is not vacuous', async () => {
    const findings = await swiftLongComments.run(session, { maxLines: 1 });
    const strings = findings.filter((f) => path.basename(f.file) === 'Strings.swift');
    // The three-line header, the two-line DocC block. Both are real
    // comments in a file whose string literals look like comments.
    expect(strings.length).toBeGreaterThanOrEqual(2);
  });

  describe('comments/stale-refs', () => {
    it('reports exactly the references that no longer resolve', async () => {
      const findings = await swiftStaleRefs.run(session, {});
      expect(findings.map((f) => f.data?.['name']).sort()).toEqual([
        'LegacyGreeter',
        'LegacyUtils.swift',
        'WidgetRegistry',
        'formatSalutation',
        'userName',
      ]);
    });

    /**
     * Swift declares an argument label and an internal name, and a doc
     * comment naming either is correct. Labels and names differ on
     * 6.8% to 25% of documented parameters across the corpora, so
     * requiring one would false-positive on up to a quarter of them.
     */
    it('accepts a - Parameter naming the label or the internal name', async () => {
      const findings = await swiftStaleRefs.run(session, {});
      const params = findings.filter((f) => f.code === 'comment.stale-param');
      expect(params).toHaveLength(1);
      expect(params[0]?.data?.['name']).toBe('userName');
      expect(params[0]?.message).toContain('parameters: name, excited');
    });

    it('classifies a missing file as a file rather than a symbol', async () => {
      const findings = await swiftStaleRefs.run(session, {});
      const file = findings.find((f) => f.data?.['kind'] === 'file');
      expect(file?.data?.['name']).toBe('LegacyUtils.swift');
      expect(file?.message).toContain('is not in this project');
    });

    /**
     * Each of these resolves through a different tier, and the tool is
     * only worth having if every one of them holds: a string literal, an
     * enum case, the SDK index, a keyword, a real file, and a path the
     * project could not be expected to own.
     */
    it('resolves through every tier, so it stays quiet about real names', async () => {
      const findings = await swiftStaleRefs.run(session, {});
      const names = new Set(findings.map((f) => f.data?.['name']));
      for (const resolved of [
        'pipelineStage',
        'addWidget',
        'ISO8601DateFormatter',
        'sorted',
        'guard',
        'Math.swift',
        'for',
        'recipient',
        '~/.config/basic.json',
      ]) {
        expect(names.has(resolved)).toBe(false);
      }
    });

    it('points at the reference inside the comment, not the whole block', async () => {
      const findings = await swiftStaleRefs.run(session, {});
      const legacy = findings.find((f) => f.data?.['name'] === 'LegacyGreeter');
      expect(legacy).toBeDefined();
      const width = (legacy?.range.end.character ?? 0) - (legacy?.range.start.character ?? 0);
      expect(width).toBe('LegacyGreeter'.length);
    });

    it('reports nothing in the all-resolves control', async () => {
      const findings = await swiftStaleRefs.run(session, {});
      expect(findings.some((f) => path.basename(f.file) === 'Notes.swift')).toBe(false);
    });
  });
});
