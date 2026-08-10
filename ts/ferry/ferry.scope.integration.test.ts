import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Finding } from '../../core/tool/index.js';
import { createTsRegistry } from '../registry.js';
import { TsFerry } from './ferry.js';

const BASIC = path.resolve(import.meta.dirname, '../../fixtures/basic-ts');
const GRAPH = path.resolve(import.meta.dirname, '../../fixtures/graph-ts');
const DUPES = path.resolve(import.meta.dirname, '../../fixtures/dupes-ts');

/**
 * Scoping the shipped tools to a changed-files list, the way a git or
 * Claude Code hook calls them. The property under test throughout: a
 * scoped run narrows what is *reported*, never what is *analyzed* —
 * symbol indexes, import graphs, and duplicate groups still span the
 * whole project, so a scoped run says the same thing about a file as a
 * full run does.
 */
describe('TsFerry file scoping over the real tools', () => {
  const ferry = new TsFerry(createTsRegistry());
  afterAll(() => ferry.dispose());

  const call = async (tool: string, root: string, files?: string[]): Promise<Finding[]> =>
    (await ferry.call(tool, root, files ? { files } : {})) as Finding[];

  const relative = (root: string, findings: Finding[]): string[] =>
    findings.map((finding) => path.relative(root, finding.file).split(path.sep).join('/'));

  it('resolves comment references against the whole project, not the scope', async () => {
    // The comments in notes.ts name helpers declared in other files of
    // the fixture; a narrowed symbol index would call them all stale.
    expect(await call('ts/comments/stale-refs', BASIC, ['src/notes.ts'])).toEqual([]);
  });

  it('reports the same findings for a scoped file as a full run does', async () => {
    const full = await call('ts/comments/stale-refs', BASIC);
    const scoped = await call('ts/comments/stale-refs', BASIC, ['src/literals.ts']);
    expect(scoped).toEqual(full.filter((finding) => finding.file.endsWith('literals.ts')));
    expect(scoped.length).toBeGreaterThan(0);
  });

  it('scopes a directory to every file beneath it', async () => {
    const full = await call('ts/comments/long', BASIC);
    expect(await call('ts/comments/long', BASIC, ['src'])).toEqual(full);
    expect(await call('ts/comments/long', BASIC, ['src/greeter.ts'])).toEqual([]);
  });

  it('reports a cycle a scoped file takes part in, wherever it is anchored', async () => {
    // The cycle is anchored on cycle-a.ts; the change is in cycle-b.ts.
    const scoped = await call('ts/graph/cycles', GRAPH, ['src/cycle-b.ts']);
    expect(relative(GRAPH, scoped)).toEqual(['src/cycle-a.ts']);
    expect(scoped[0]?.data?.files).toEqual(['src/cycle-a.ts', 'src/cycle-b.ts', 'src/cycle-c.ts']);
    expect(await call('ts/graph/cycles', GRAPH, ['src/util.ts'])).toEqual([]);
  });

  it('judges dead exports against every importer in the project', async () => {
    const full = await call('ts/graph/dead-exports', GRAPH);
    const scoped = await call('ts/graph/dead-exports', GRAPH, ['src/orphan.ts', 'src/lib.ts']);
    expect(scoped).toEqual(
      full.filter(
        (finding) =>
          finding.file.endsWith('/orphan.ts') || finding.file.endsWith('/lib.ts'),
      ),
    );
    expect(relative(GRAPH, scoped)).toContain('src/orphan.ts');
  });

  it('keeps duplicate groups whole, listing peers outside the scope', async () => {
    const scoped = await call('ts/dupes/functions', DUPES, ['src/alpha.ts']);
    expect(relative(DUPES, scoped)).toEqual(['src/alpha.ts']);
    expect(scoped[0]?.message).toContain('src/beta.ts');
  });
});
