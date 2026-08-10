import ts from 'typescript';
import type { TsProjectSession } from '../project/index.js';

/**
 * Who else declares this member.
 *
 * A method's signature is not its own: it is shared with the base
 * declaration it overrides, with every subclass that overrides it, and
 * with every interface signature it satisfies — which in a structurally
 * typed language it may satisfy without naming. `ts.Program` indexes
 * inheritance in one direction only, so the reverse edges have to be
 * built by scanning heritage clauses and resolving each through the
 * checker.
 *
 * Signature-shaped refactorings use this as a refusal check: a member
 * that participates in a hierarchy cannot have its signature changed
 * alone, and a hierarchy the checker cannot resolve is reported as
 * un-analyzable rather than silently treated as empty.
 */

export interface MemberDeclaration {
  file: string;
  line: number;
  character: number;
  /** The class or interface the member is declared on. */
  container: string;
  node: ts.NamedDeclaration;
}

export interface HierarchyResult {
  /** Base and interface declarations the member satisfies. */
  supertypes: MemberDeclaration[];
  /** Overrides in subtypes, transitively. */
  subtypes: MemberDeclaration[];
  /**
   * Heritage clauses that resolve to no class symbol — a mixin
   * (`class X extends WithLogging(Base)`) or an unresolved import.
   * Non-empty means the closure is incomplete, and a tool relying on
   * it should refuse rather than assume it saw everything.
   */
  unresolved: string[];
}

type Container = ts.ClassLikeDeclaration | ts.InterfaceDeclaration;

function isContainer(node: ts.Node): node is Container {
  return ts.isClassLike(node) || ts.isInterfaceDeclaration(node);
}

function containerName(container: Container): string {
  return container.name?.text ?? '(anonymous)';
}

function memberNamed(container: Container, name: string): ts.NamedDeclaration | undefined {
  for (const member of container.members) {
    if (member.name && ts.isIdentifier(member.name) && member.name.text === name) {
      return member;
    }
  }
  return undefined;
}

function describe(
  container: Container,
  member: ts.NamedDeclaration,
  sourceFile: ts.SourceFile,
): MemberDeclaration {
  const start = (member.name ?? member).getStart(sourceFile);
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
  return {
    file: sourceFile.fileName,
    line,
    character,
    container: containerName(container),
    node: member,
  };
}

/** Every class and interface in the project, with its source file. */
function containers(session: TsProjectSession): { node: Container; sourceFile: ts.SourceFile }[] {
  const found: { node: Container; sourceFile: ts.SourceFile }[] = [];
  for (const sourceFile of session.sourceFiles()) {
    const visit = (node: ts.Node) => {
      if (isContainer(node)) found.push({ node, sourceFile });
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  return found;
}

/**
 * The declarations a heritage clause names, resolved through the
 * checker. An expression that is not a plain type reference — a mixin
 * call, most often — resolves to nothing and is reported as such.
 */
function heritageOf(
  container: Container,
  checker: ts.TypeChecker,
  unresolved: string[],
): Container[] {
  const parents: Container[] = [];
  for (const clause of container.heritageClauses ?? []) {
    for (const type of clause.types) {
      let symbol = checker.getSymbolAtLocation(type.expression);
      // An imported base class resolves to the import specifier, not
      // the class. Left unaliased, every cross-file `extends` looks
      // un-analyzable and a genuine override reads as a standalone
      // member — an unsoundness, not just a gap.
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      const declarations = symbol?.declarations?.filter(isContainer) ?? [];
      if (declarations.length === 0) {
        unresolved.push(
          `${containerName(container)} ${clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements'} ${type.expression.getText()}`,
        );
        continue;
      }
      parents.push(...declarations);
    }
  }
  return parents;
}

/**
 * Every other declaration of `member` that must move with it. Pass the
 * member declaration itself; the container is read from its parent.
 */
export function memberHierarchy(
  session: TsProjectSession,
  member: ts.NamedDeclaration,
): HierarchyResult {
  const container = member.parent;
  if (!container || !isContainer(container)) {
    return { supertypes: [], subtypes: [], unresolved: [] };
  }
  const name = member.name && ts.isIdentifier(member.name) ? member.name.text : undefined;
  if (!name) return { supertypes: [], subtypes: [], unresolved: [] };

  const checker = session.checker();
  const all = containers(session);
  const unresolved: string[] = [];

  // Upward: walk heritage clauses transitively.
  const supertypes: MemberDeclaration[] = [];
  const seenUp = new Set<Container>([container]);
  const queue: Container[] = [container];
  while (queue.length > 0) {
    for (const parent of heritageOf(queue.pop()!, checker, unresolved)) {
      if (seenUp.has(parent)) continue;
      seenUp.add(parent);
      queue.push(parent);
      const declaration = memberNamed(parent, name);
      if (declaration) {
        supertypes.push(describe(parent, declaration, parent.getSourceFile()));
      }
    }
  }

  // Downward: anything whose transitive heritage reaches this container.
  const subtypes: MemberDeclaration[] = [];
  for (const candidate of all) {
    if (candidate.node === container) continue;
    const seenDown = new Set<Container>();
    const pending: Container[] = [candidate.node];
    let reaches = false;
    while (pending.length > 0 && !reaches) {
      const current: Container = pending.pop()!;
      if (seenDown.has(current)) continue;
      seenDown.add(current);
      for (const parent of heritageOf(current, checker, unresolved)) {
        if (parent === container) reaches = true;
        pending.push(parent);
      }
    }
    if (!reaches) continue;
    const declaration = memberNamed(candidate.node, name);
    if (declaration) {
      subtypes.push(describe(candidate.node, declaration, candidate.sourceFile));
    }
  }

  return { supertypes, subtypes, unresolved: [...new Set(unresolved)] };
}
