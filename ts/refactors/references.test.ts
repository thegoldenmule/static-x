import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../project/index.js';
import { resolveTarget } from '../ast/targets.js';
import { classifyReferences, isWrite, type ReferenceKind } from './references.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/refactor-core-ts');

const session = TsProjectSession.open(FIXTURE);
afterAll(() => session.dispose());

/** Every reference kind found for a symbol, as `file:line kind`. */
function kindsFor(symbol: string, options?: { callable?: ReadonlySet<string> }) {
  const target = resolveTarget(session, { symbol });
  return classifyReferences(session, target.file, target.offset, options ?? {}).map(
    (reference) =>
      `${path.basename(reference.file)}:${reference.line + 1} ${reference.kind}` as const,
  );
}

describe('classifyReferences', () => {
  it('reads a destructured property rather than calling it a write', { timeout: 30_000 }, () => {
    const target = resolveTarget(session, { symbol: 'count' });
    const references = classifyReferences(session, target.file, target.offset);

    // `const { count } = counter` is a read; the language service's own
    // isWriteAccess reports true for it, which is why this tool does not use it.
    const destructure = references.find((reference) => reference.file.endsWith('uses.ts'));
    expect(destructure?.kind).toBe<ReferenceKind>('destructure-read');
    expect(destructure && isWrite(destructure)).toBe(false);
  });

  it('separates the writes that block readonly from the reads that do not', () => {
    const target = resolveTarget(session, { symbol: 'count' });
    const writes = classifyReferences(session, target.file, target.offset).filter(isWrite);

    // `this.count += 1` in bump, `this.count = 0` in reset — and nothing else.
    expect(writes.map((write) => write.kind).sort()).toEqual(['compound-write', 'write']);
  });

  it('calls a direct call a call, and a value-position use an escape', () => {
    const kinds = kindsFor('scale', { callable: new Set(['scale']) });

    expect(kinds).toContain('uses.ts:11 direct-call');
    // `values.map(...)` passes an arrow, but `scale` inside it is still a call.
    expect(kinds).toContain('uses.ts:16 direct-call');
    // `scale.bind(...)` moves the receiver; `[scale]` hands the function out.
    expect(kinds).toContain('uses.ts:19 escape');
    expect(kinds).toContain('uses.ts:21 escape');
  });

  it('treats typeof as an escape, since a signature change silently retypes it', () => {
    expect(kindsFor('scale', { callable: new Set(['scale']) })).toContain('counter.ts:22 escape');
  });

  it('distinguishes import bindings from uses', () => {
    expect(kindsFor('scale', { callable: new Set(['scale']) })).toContain('uses.ts:1 import-binding');
  });
});
