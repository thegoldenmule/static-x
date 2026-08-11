import path from 'node:path';
import type { Finding, Tool } from '../../../core/tool/index.js';
import { FINDINGS_ARRAY_SCHEMA } from '../../../core/tool/index.js';
import type { TsProjectSession } from '../../project/index.js';
import { hasHiddenDirSegment, toProjectRelative } from '../../project/index.js';
import type { ImportEdge, ImportGraph } from '../import-graph.js';
import { buildImportGraph } from '../import-graph.js';

/**
 * Finds import cycles (graph.cycle): strongly-connected components of
 * the resolved module graph, one finding per component — overlapping
 * loops through the same files are one group, reported once.
 */

export type ImportCyclesInput = Record<string, never>;

/**
 * Total order on edges from one file: start position, then end position,
 * then target path. The trailing tie-breakers keep anchor-edge selection
 * deterministic even if a graph producer emits two edges sharing a start
 * position (the compiler-based builder never does, but the contract of
 * `findCycles` promises determinism for any graph value).
 */
function byPositionThenTarget(a: ImportEdge, b: ImportEdge): number {
  return (
    a.range.start.line - b.range.start.line ||
    a.range.start.character - b.range.start.character ||
    a.range.end.line - b.range.end.line ||
    a.range.end.character - b.range.end.character ||
    (a.to < b.to ? -1 : a.to > b.to ? 1 : 0)
  );
}

/**
 * Tarjan's SCC with an explicit frame stack — recursion depth would be
 * bounded by the longest import chain, which large projects exceed.
 * Deterministic given sorted `nodes` and sorted adjacency lists.
 */
function stronglyConnectedComponents(
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const discover = (node: string): void => {
    low.set(node, order.size);
    order.set(node, order.size);
    stack.push(node);
    onStack.add(node);
  };

  for (const root of nodes) {
    if (order.has(root)) continue;
    discover(root);
    const frames: { node: string; next: number }[] = [{ node: root, next: 0 }];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) break;
      const neighbors = adjacency.get(frame.node) ?? [];
      const target = neighbors[frame.next];
      if (target !== undefined) {
        frame.next += 1;
        if (!order.has(target)) {
          discover(target);
          frames.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, order.get(target) ?? 0));
        }
        continue;
      }

      frames.pop();
      const frameLow = low.get(frame.node) ?? 0;
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        low.set(parent.node, Math.min(low.get(parent.node) ?? 0, frameLow));
      }
      if (frameLow === order.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        components.push(component);
      }
    }
  }
  return components;
}

/**
 * Shortest loop through `anchor` over in-component edges, by BFS with
 * predecessor links. Returns the member sequence anchor → … → anchor;
 * a self-edge yields [anchor, anchor].
 */
function shortestLoop(
  anchor: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[] {
  const parent = new Map<string, string>();
  const queue: string[] = [anchor];
  for (let i = 0; i < queue.length; i += 1) {
    const node = queue[i];
    if (node === undefined) break;
    for (const next of adjacency.get(node) ?? []) {
      if (next === anchor) {
        const tail: string[] = [];
        for (let at = node; at !== anchor; ) {
          tail.push(at);
          const previous = parent.get(at);
          if (previous === undefined) break;
          at = previous;
        }
        tail.reverse();
        return [anchor, ...tail, anchor];
      }
      if (!parent.has(next)) {
        parent.set(next, node);
        queue.push(next);
      }
    }
  }
  return [anchor, anchor];
}

/**
 * One finding per import cycle in the graph. Pure over the graph value:
 * `rootPath` is used only to render project-relative paths and to
 * classify hidden-directory members. Hidden-directory files (generated
 * output the graph keeps for edge completeness) are never finding
 * subjects: the anchor is the lexicographically-first non-hidden
 * member, and a component living entirely under hidden directories is
 * skipped. Findings are sorted by anchor path; members, adjacency, and
 * the displayed loop are all ordered, so output is deterministic for a
 * given graph regardless of edge order.
 */
export function findCycles(graph: ImportGraph, rootPath: string): Finding[] {
  const nodes = new Set<string>();
  const selfEdges = new Set<string>();
  const valueSelfEdges = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const valueAdjacency = new Map<string, string[]>();
  const link = (map: Map<string, string[]>, from: string, to: string): void => {
    let targets = map.get(from);
    if (!targets) {
      targets = [];
      map.set(from, targets);
    }
    if (!targets.includes(to)) targets.push(to);
  };
  for (const edge of graph.edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
    if (edge.from === edge.to) {
      selfEdges.add(edge.from);
      if (!edge.typeOnly) valueSelfEdges.add(edge.from);
    }
    link(adjacency, edge.from, edge.to);
    if (!edge.typeOnly) link(valueAdjacency, edge.from, edge.to);
  }
  for (const targets of adjacency.values()) targets.sort();
  for (const targets of valueAdjacency.values()) targets.sort();
  const sortedNodes = [...nodes].sort();

  // Whether a cycle survives to runtime is decided by the value edges
  // alone, so the components are computed twice rather than once and
  // labelled afterwards. Asking `innerEdges.every(typeOnly)` of a
  // component built from *all* edges answers a different question: a
  // loop that can only be closed through an `import type` still
  // contains value edges elsewhere, so it was reported as a runtime
  // cycle — "initialization order is fragile", at high confidence,
  // about an edge the emit erases.
  const planned: { component: string[]; typeOnly: boolean }[] = [];
  const cyclic = (component: string[], loops: ReadonlySet<string>): boolean => {
    if (component.length > 1) return true;
    const only = component[0];
    return only !== undefined && loops.has(only);
  };
  for (const component of stronglyConnectedComponents(sortedNodes, valueAdjacency)) {
    if (cyclic(component, valueSelfEdges)) planned.push({ component, typeOnly: false });
  }
  const atRuntime = new Set(planned.flatMap((entry) => entry.component));
  for (const component of stronglyConnectedComponents(sortedNodes, adjacency)) {
    if (!cyclic(component, selfEdges)) continue;
    // A tangle holding a runtime cycle is already reported, at the more
    // severe of its two truths. Reporting it again as type-only would
    // describe the same files twice and disagree with itself.
    if (component.some((file) => atRuntime.has(file))) continue;
    planned.push({ component, typeOnly: true });
  }

  const results: { name: string; finding: Finding }[] = [];
  for (const { component, typeOnly } of planned) {
    const members = new Set(component);
    // A runtime cycle is described by its runtime edges: the loop drawn
    // and the anchor blamed both have to be edges that survive the emit.
    const pool = typeOnly ? graph.edges : graph.edges.filter((e) => !e.typeOnly);
    const scoped = typeOnly ? adjacency : valueAdjacency;
    const innerEdges = pool.filter((e) => members.has(e.from) && members.has(e.to));

    const files = component
      .map((file) => ({ file, relative: toProjectRelative(rootPath, file) }))
      .sort((a, b) => (a.relative < b.relative ? -1 : 1));
    const anchor = files.find((f) => !hasHiddenDirSegment(path.relative(rootPath, f.file)));
    if (anchor === undefined) continue;

    const innerAdjacency = new Map<string, string[]>();
    for (const member of component) {
      innerAdjacency.set(member, (scoped.get(member) ?? []).filter((t) => members.has(t)));
    }
    const loop = shortestLoop(anchor.file, innerAdjacency).map((f) =>
      toProjectRelative(rootPath, f),
    );
    const loopText = loop.join(' → ');
    const size = component.length;
    const groupNote =
      size > new Set(loop).size
        ? ` The loop is part of a strongly-connected group of ${size} files that all reach each other.`
        : '';
    const message = typeOnly
      ? `Type-only import cycle: ${loopText}. The loop cannot be closed without an ` +
        '`import type`, so it is erased at runtime — legal and common, but it still tangles ' +
        'the module structure; break it the same way as a value cycle, by extracting the ' +
        'shared types into a module both sides import.' +
        groupNote
      : `Import cycle: ${loopText}. Import cycles make initialization order fragile and ` +
        'defeat tree-shaking; break the cycle by extracting the shared piece into a module ' +
        'both sides import.' +
        groupNote;

    const anchorEdge = innerEdges
      .filter((e) => e.from === anchor.file)
      .sort(byPositionThenTarget)[0];
    results.push({
      name: anchor.relative,
      finding: {
        file: anchor.file,
        range: anchorEdge?.range ?? {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        code: 'graph.cycle',
        message,
        severity: typeOnly ? 'info' : 'warning',
        data: {
          name: anchor.relative,
          kind: typeOnly ? 'type-only' : 'value',
          files: files.map((f) => f.relative),
          size,
          typeOnly,
          confidence: 'high',
        },
      },
    });
  }
  return results.sort((a, b) => (a.name < b.name ? -1 : 1)).map((r) => r.finding);
}

export const importCycles: Tool<ImportCyclesInput, Finding[], TsProjectSession> = {
  name: 'ts/graph/cycles',
  description:
    'Finds import cycles (graph.cycle) as strongly-connected components of the resolved ' +
    'module graph — every import, re-export, dynamic import, and require resolved through ' +
    'the compiler module resolution, tsconfig paths aliases included — one finding per ' +
    'cycle group, so overlapping loops through the same files report once. Value cycles ' +
    'are warnings: they make initialization order fragile and defeat tree-shaking. Cycles ' +
    'whose every edge is import type are info: erased at runtime, legal, but structural ' +
    'debt. Break a cycle by extracting the shared piece into a module both sides import.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: FINDINGS_ARRAY_SCHEMA,
  run(session) {
    return Promise.resolve(findCycles(buildImportGraph(session), session.rootPath));
  },
};
