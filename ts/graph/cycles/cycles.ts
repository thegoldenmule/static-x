import path from 'node:path';
import type { Finding, Tool } from '../../../core/tool/index.js';
import type { TsProjectSession } from '../../project/index.js';
import type { ImportEdge, ImportGraph } from '../import-graph.js';
import { buildImportGraph } from '../import-graph.js';

/**
 * Finds import cycles (graph.cycle): strongly-connected components of
 * the resolved module graph, one finding per component — overlapping
 * loops through the same files are one group, reported once.
 */

export type ImportCyclesInput = Record<string, never>;

function toRelative(rootPath: string, file: string): string {
  return path.relative(rootPath, file).split(path.sep).join('/');
}

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
 * `rootPath` is used only to render project-relative paths. Findings
 * are sorted by anchor path; members, adjacency, and the displayed
 * loop are all ordered, so output is deterministic for a given graph
 * regardless of edge order.
 */
export function findCycles(graph: ImportGraph, rootPath: string): Finding[] {
  const nodes = new Set<string>();
  const selfEdges = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
    if (edge.from === edge.to) selfEdges.add(edge.from);
    let targets = adjacency.get(edge.from);
    if (!targets) {
      targets = [];
      adjacency.set(edge.from, targets);
    }
    if (!targets.includes(edge.to)) targets.push(edge.to);
  }
  for (const targets of adjacency.values()) targets.sort();
  const sortedNodes = [...nodes].sort();

  const results: { name: string; finding: Finding }[] = [];
  for (const component of stronglyConnectedComponents(sortedNodes, adjacency)) {
    if (component.length === 1) {
      const only = component[0];
      if (only === undefined || !selfEdges.has(only)) continue;
    }
    const members = new Set(component);
    const innerEdges = graph.edges.filter((e) => members.has(e.from) && members.has(e.to));
    const typeOnly = innerEdges.every((e) => e.typeOnly);

    const files = component
      .map((file) => ({ file, relative: toRelative(rootPath, file) }))
      .sort((a, b) => (a.relative < b.relative ? -1 : 1));
    const anchor = files[0];
    if (anchor === undefined) continue;

    const innerAdjacency = new Map<string, string[]>();
    for (const member of component) {
      innerAdjacency.set(member, (adjacency.get(member) ?? []).filter((t) => members.has(t)));
    }
    const loop = shortestLoop(anchor.file, innerAdjacency).map((f) => toRelative(rootPath, f));
    const loopText = loop.join(' → ');
    const size = component.length;
    const groupNote =
      size > new Set(loop).size
        ? ` The loop is part of a strongly-connected group of ${size} files that all reach each other.`
        : '';
    const message = typeOnly
      ? `Type-only import cycle: ${loopText}. Every edge is \`import type\`, so the cycle is ` +
        'erased at runtime — legal and common, but it still tangles the module structure.' +
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
    'Finds import cycles as strongly-connected components of the resolved module graph — ' +
    'every import, re-export, dynamic import, and require resolved through the compiler ' +
    'module resolution, tsconfig paths aliases included — one finding per cycle group, so ' +
    'overlapping loops through the same files report once. Value cycles are warnings: they ' +
    'make initialization order fragile and defeat tree-shaking. Cycles whose every edge is ' +
    'import type are info: erased at runtime, legal, but structural debt. Break a cycle by ' +
    'extracting the shared piece into a module both sides import.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'array', items: { $ref: '#/definitions/finding' } },
  run(session) {
    return Promise.resolve(findCycles(buildImportGraph(session), session.rootPath));
  },
};
