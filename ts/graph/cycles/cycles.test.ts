import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import type { ImportEdge, ImportGraph } from '../import-graph.js';
import { findCycles, importCycles } from './cycles.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/graph-ts');
const ROOT = '/proj';

function edge(from: string, to: string, line = 0, typeOnly = false, endChar = 40): ImportEdge {
  return {
    from: path.join(ROOT, from),
    to: path.join(ROOT, to),
    typeOnly,
    range: { start: { line, character: 0 }, end: { line, character: endChar } },
  };
}

function graphOf(...edges: ImportEdge[]): ImportGraph {
  return { edges, consumedNames: new Map(), importers: new Map() };
}

describe('findCycles', () => {
  it('reports nothing for an acyclic graph', () => {
    const graph = graphOf(edge('a.ts', 'b.ts'), edge('b.ts', 'c.ts'), edge('a.ts', 'c.ts'));
    expect(findCycles(graph, ROOT)).toEqual([]);
  });

  it('reports a two-file cycle once as a warning', () => {
    const findings = findCycles(graphOf(edge('a.ts', 'b.ts', 3), edge('b.ts', 'a.ts', 1)), ROOT);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: path.join(ROOT, 'a.ts'),
      code: 'graph.cycle',
      severity: 'warning',
      range: { start: { line: 3, character: 0 } },
      data: { name: 'a.ts', files: ['a.ts', 'b.ts'], size: 2, typeOnly: false, confidence: 'high' },
    });
    expect(findings[0]?.message).toContain('a.ts → b.ts → a.ts');
  });

  it('reports disjoint cycles separately, sorted by anchor path', () => {
    const findings = findCycles(
      graphOf(edge('m.ts', 'n.ts'), edge('n.ts', 'm.ts'), edge('a.ts', 'b.ts'), edge('b.ts', 'a.ts')),
      ROOT,
    );
    expect(findings.map((f) => f.data?.name)).toEqual(['a.ts', 'm.ts']);
  });

  it('merges overlapping loops into one strongly-connected group', () => {
    const findings = findCycles(
      graphOf(edge('a.ts', 'b.ts'), edge('b.ts', 'a.ts'), edge('b.ts', 'c.ts'), edge('c.ts', 'b.ts')),
      ROOT,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data).toMatchObject({ files: ['a.ts', 'b.ts', 'c.ts'], size: 3 });
    expect(findings[0]?.message).toContain('a.ts → b.ts → a.ts');
    expect(findings[0]?.message).toContain('strongly-connected group of 3 files');
  });

  it('sorts findings by anchor path, not severity', () => {
    // The info cycle's path sorts before the warning cycle's path, so a
    // regression to severity-first ordering would flip this expectation.
    const findings = findCycles(
      graphOf(
        edge('aa1.ts', 'aa2.ts', 1, true),
        edge('aa2.ts', 'aa1.ts', 2, true),
        edge('zz1.ts', 'zz2.ts', 3),
        edge('zz2.ts', 'zz1.ts', 4),
      ),
      ROOT,
    );
    expect(findings.map((f) => [f.data?.name, f.severity])).toEqual([
      ['aa1.ts', 'info'],
      ['zz1.ts', 'warning'],
    ]);
  });

  it('reports a self-import as a one-file loop without a group note', () => {
    const findings = findCycles(graphOf(edge('a.ts', 'a.ts', 2)), ROOT);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: path.join(ROOT, 'a.ts'),
      range: { start: { line: 2, character: 0 } },
      data: { files: ['a.ts'], size: 1 },
    });
    expect(findings[0]?.message).toContain('a.ts → a.ts');
    expect(findings[0]?.message).not.toContain('strongly-connected group');
  });

  it('folds a self-edge inside a larger group into the group finding', () => {
    const edges = [edge('a.ts', 'a.ts', 1), edge('a.ts', 'b.ts', 2), edge('b.ts', 'a.ts', 3)];
    const findings = findCycles(graphOf(...edges), ROOT);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data).toMatchObject({ files: ['a.ts', 'b.ts'], size: 2 });
    // The self-edge is the shortest loop through the anchor; the note then
    // flags the wider strongly-connected group.
    expect(findings[0]?.message).toContain('a.ts → a.ts');
    expect(findings[0]?.message).toContain('strongly-connected group of 2 files');
    const reversed = findCycles(graphOf(...[...edges].reverse()), ROOT);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(findings));
  });

  it('downgrades an all-type-only cycle to info', () => {
    const findings = findCycles(
      graphOf(edge('a.ts', 'b.ts', 0, true), edge('b.ts', 'a.ts', 0, true)),
      ROOT,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'info', data: { typeOnly: true } });
    expect(findings[0]?.message).toContain('Type-only import cycle');
  });

  it('keeps a mixed value/type cycle at warning', () => {
    const findings = findCycles(graphOf(edge('a.ts', 'b.ts', 0, true), edge('b.ts', 'a.ts')), ROOT);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'warning', data: { typeOnly: false } });
    expect(findings[0]?.message).toContain('Import cycle');
  });

  it('anchors at the lexicographically-first member with its in-cycle import range', () => {
    const findings = findCycles(
      graphOf(
        edge('b.ts', 'a.ts', 9),
        // Out-of-cycle import above the cycle edge must not win the range.
        edge('a.ts', 'out.ts', 0),
        edge('a.ts', 'b.ts', 7),
      ),
      ROOT,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe(path.join(ROOT, 'a.ts'));
    expect(findings[0]?.range).toEqual({
      start: { line: 7, character: 0 },
      end: { line: 7, character: 40 },
    });
  });

  it('produces identical JSON regardless of edge order', () => {
    const edges = [
      edge('a.ts', 'b.ts', 1),
      edge('b.ts', 'c.ts', 2),
      edge('c.ts', 'a.ts', 3),
      edge('b.ts', 'a.ts', 4),
      edge('t1.ts', 't2.ts', 5, true),
      edge('t2.ts', 't1.ts', 6, true),
    ];
    const forward = findCycles(graphOf(...edges), ROOT);
    const reversed = findCycles(graphOf(...[...edges].reverse()), ROOT);
    const shuffled = findCycles(
      graphOf(...[4, 1, 5, 0, 2, 3].map((i) => edges[i]).filter((e) => e !== undefined)),
      ROOT,
    );
    expect(forward.map((f) => f.data?.name)).toEqual(['a.ts', 't1.ts']);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(forward));
  });

  it('breaks anchor-edge ties deterministically when two in-cycle imports share a start', () => {
    // Both anchor edges start at line 1 char 0; only end position differs.
    // Without tie-breakers past the start position, the winning range would
    // follow input edge order.
    const edges = [
      edge('a.ts', 'b.ts', 1, false, 40),
      edge('a.ts', 'c.ts', 1, false, 55),
      edge('b.ts', 'a.ts', 2),
      edge('c.ts', 'a.ts', 3),
    ];
    const forward = findCycles(graphOf(...edges), ROOT);
    const reversed = findCycles(graphOf(...[...edges].reverse()), ROOT);
    expect(forward).toHaveLength(1);
    expect(forward[0]?.range).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 40 },
    });
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it('handles a 2000-file cycle without recursion overflow', () => {
    // Guards the iterative-Tarjan rationale: a refactor back to recursion
    // would throw RangeError here long before real-project chain lengths.
    const n = 2000;
    const edges: ImportEdge[] = [];
    for (let i = 0; i < n; i += 1) {
      const name = (k: number): string => `f${String(k % n).padStart(4, '0')}.ts`;
      edges.push(edge(name(i), name(i + 1), i));
    }
    const findings = findCycles(graphOf(...edges), ROOT);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data).toMatchObject({ size: n });
  });
});

describe('ts/graph/cycles on the fixture project', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('flags exactly the two planted cycles and nothing else', async () => {
    const findings = await importCycles.run(session, {});
    expect(findings.map((f) => [f.data?.name, f.data?.size, f.severity])).toEqual([
      ['src/cycle-a.ts', 3, 'warning'],
      ['src/type-a.ts', 2, 'info'],
    ]);
  });

  it('reports the value cycle with the full loop, anchored on the import line', async () => {
    const findings = await importCycles.run(session, {});
    expect(findings[0]).toMatchObject({
      file: path.join(FIXTURE, 'src', 'cycle-a.ts'),
      code: 'graph.cycle',
      severity: 'warning',
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 34 } },
      data: {
        name: 'src/cycle-a.ts',
        files: ['src/cycle-a.ts', 'src/cycle-b.ts', 'src/cycle-c.ts'],
        size: 3,
        typeOnly: false,
        confidence: 'high',
      },
    });
    expect(findings[0]?.message).toContain(
      'src/cycle-a.ts → src/cycle-b.ts → src/cycle-c.ts → src/cycle-a.ts',
    );
    expect(findings[0]?.message).not.toContain('strongly-connected group');
  });

  it('downgrades the type-only cycle to info, anchored on its import line', async () => {
    const findings = await importCycles.run(session, {});
    expect(findings[1]).toMatchObject({
      file: path.join(FIXTURE, 'src', 'type-a.ts'),
      code: 'graph.cycle',
      severity: 'info',
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 38 } },
      data: {
        name: 'src/type-a.ts',
        files: ['src/type-a.ts', 'src/type-b.ts'],
        size: 2,
        typeOnly: true,
        confidence: 'high',
      },
    });
    expect(findings[1]?.message).toContain(
      'Type-only import cycle: src/type-a.ts → src/type-b.ts → src/type-a.ts',
    );
  });
});
