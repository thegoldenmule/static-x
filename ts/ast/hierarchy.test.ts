import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../project/index.js';
import { memberHierarchy } from './hierarchy.js';
import { resolveTarget } from './targets.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/refactor-core-ts');

const session = TsProjectSession.open(FIXTURE);
afterAll(() => session.dispose());

/** The member named `member` on the class named `className`. */
function memberOf(className: string, member: string): ts.NamedDeclaration {
  const target = resolveTarget(session, { symbol: className });
  const declaration = target.declaration;
  if (!declaration || !ts.isClassLike(declaration)) {
    throw new Error(`${className} is not a class`);
  }
  for (const candidate of declaration.members) {
    if (candidate.name && ts.isIdentifier(candidate.name) && candidate.name.text === member) {
      return candidate;
    }
  }
  throw new Error(`${className} has no member ${member}`);
}

describe('memberHierarchy', () => {
  it('resolves a base class reached through an import', { timeout: 30_000 }, () => {
    const result = memberHierarchy(session, memberOf('Square', 'area'));

    // `class Square extends Shape` binds Shape to an import specifier,
    // not the class. Unaliased, this comes back empty and a genuine
    // override reads as a standalone method — unsound, not merely
    // incomplete.
    expect(result.supertypes.map((declaration) => declaration.container)).toContain('Shape');
    expect(result.unresolved).toEqual([]);
  });

  it('finds overrides in subtypes', () => {
    const result = memberHierarchy(session, memberOf('Square', 'area'));

    expect(result.subtypes.map((declaration) => declaration.container)).toContain('Tile');
  });

  it('reports a member no other type declares as standalone', () => {
    const result = memberHierarchy(session, memberOf('Square', 'draw'));

    // `draw` satisfies Drawable, which Square names explicitly.
    expect(result.supertypes.map((declaration) => declaration.container)).toEqual(['Drawable']);
    expect(result.subtypes).toEqual([]);
  });
});
