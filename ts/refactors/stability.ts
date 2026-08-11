import ts from 'typescript';
import type { TsProjectSession } from '../project/index.js';
import { classifyReferences, isWrite } from './references.js';
import { rootIdentifiers } from './substitution.js';

/**
 * Whether an expression still means what it meant once it is moved to
 * where it is read.
 *
 * Every inline refactoring asks the same question and it is almost never
 * "does this typecheck". `const v = bump()` read three times becomes
 * three calls; `const o = {k: 1}` compared to itself becomes two
 * objects; a name the initializer reads may hold something else by the
 * time the read runs. All of them compile, and
 * `diagnosticsIntroducedBy` reports nothing for any of them — which is
 * why these predicates decide before an edit is built rather than after.
 *
 * The predicates are deliberately one-sided: each answers "might this be
 * unsafe", never "is this safe", so a caller that refuses on `true` is
 * conservative and a caller that proceeds on `false` is sound.
 */

/** Expressions that produce a new object every time they are evaluated. */
export function allocates(expression: ts.Node): boolean {
  let fresh = false;
  const visit = (node: ts.Node): void => {
    if (fresh) return;
    if (
      ts.isObjectLiteralExpression(node) ||
      ts.isArrayLiteralExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassExpression(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      fresh = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(expression);
  return fresh;
}

/**
 * Whether the expression reads a property, which may hold a different
 * value at the read than it held at the declaration.
 *
 * An enum member is excluded: it is the one property access the language
 * guarantees cannot change.
 */
export function readsProperty(checker: ts.TypeChecker, expression: ts.Node): boolean {
  let volatile = false;
  const visit = (node: ts.Node): void => {
    if (volatile) return;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol || (symbol.flags & ts.SymbolFlags.EnumMember) === 0) {
        volatile = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(expression);
  return volatile;
}

/** Whether evaluating this node is itself an observable act. */
export function isEffectfulNode(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isTaggedTemplateExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isYieldExpression(node) ||
    ts.isDeleteExpression(node) ||
    ts.isPostfixUnaryExpression(node) ||
    (ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)) ||
    (ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
  );
}

/**
 * The constructs standing between a read and the declaration, plus the
 * innermost node enclosing both.
 *
 * Ancestors are collected until one of them contains the declaration, so
 * a loop wrapping *both* — where the two run together and the count is
 * unchanged — is correctly not counted as coming between them.
 */
export function pathToDeclaration(
  read: ts.Node,
  declaration: ts.Node,
): { between: ts.Node[]; common: ts.Node | undefined } {
  const start = declaration.getStart();
  const end = declaration.getEnd();
  const between: ts.Node[] = [];
  for (let node: ts.Node | undefined = read.parent; node; node = node.parent) {
    if (node.getStart() <= start && end <= node.getEnd()) return { between, common: node };
    between.push(node);
  }
  return { between, common: undefined };
}

/** Whether the read may run a different number of times than the declaration. */
export function repeatsOrSkips(between: readonly ts.Node[]): boolean {
  return between.some(
    (node) =>
      ts.isFunctionLike(node) ||
      ts.isClassStaticBlockDeclaration(node) ||
      ts.isIterationStatement(node, false) ||
      ts.isIfStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isCaseClause(node) ||
      ts.isCatchClause(node) ||
      ts.isConditionalExpression(node) ||
      (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)),
  );
}

/** Whether anything observable is evaluated in `(from, to)` under `common`. */
export function effectsBetween(common: ts.Node, from: number, to: number): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || node.getEnd() <= from || node.getStart() >= to) return;
    if (isEffectfulNode(node)) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };
  common.forEachChild(visit);
  return found;
}

/** The nearest scope that gives `this` its meaning. */
export function thisScope(node: ts.Node): ts.Node | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (
      ts.isSourceFile(current) ||
      ts.isClassStaticBlockDeclaration(current) ||
      (ts.isFunctionLike(current) && !ts.isArrowFunction(current))
    ) {
      return current;
    }
  }
  return undefined;
}

/** Whether the expression's own meaning depends on `this` or `super`. */
export function usesReceiver(expression: ts.Node): boolean {
  let receiver = false;
  const visit = (node: ts.Node): void => {
    if (receiver) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
      receiver = true;
      return;
    }
    // A nested non-arrow function rebinds `this`, so what its body does
    // with the keyword says nothing about the receiver here.
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return;
    node.forEachChild(visit);
  };
  visit(expression);
  return receiver;
}

/**
 * Names the initializer reads that could hold something else later.
 *
 * This is the capture failure `captureConflicts` cannot see: the name
 * resolves to the very same symbol at the read site and still means a
 * different number. `let w = 1; const n = w * 2; w = 5; return n`
 * returns 2 today and 10 inlined, and both compile.
 */
export function reassignedNames(session: TsProjectSession, initializer: ts.Expression): string[] {
  const checker = session.checker();
  const unstable: string[] = [];
  const seen = new Set<string>();
  for (const identifier of rootIdentifiers(initializer)) {
    if (seen.has(identifier.text)) continue;
    seen.add(identifier.text);

    const symbol = checker.getSymbolAtLocation(identifier);
    const mutable = (symbol?.declarations ?? []).filter(
      (declaration): declaration is ts.ParameterDeclaration | ts.VariableDeclaration =>
        ts.isParameter(declaration) ||
        (ts.isVariableDeclaration(declaration) &&
          (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0),
    );
    if (mutable.length === 0) continue;

    for (const declaration of mutable) {
      const sourceFile = declaration.getSourceFile();
      const declared = declaration.name;
      if (!ts.isIdentifier(declared)) {
        unstable.push(identifier.text);
        break;
      }
      const writes = classifyReferences(
        session,
        sourceFile.fileName,
        declared.getStart(sourceFile),
      ).filter(isWrite);
      if (writes.length > 0) {
        unstable.push(identifier.text);
        break;
      }
    }
  }
  return unstable;
}

/**
 * The node a read occupies: the identifier, or the whole access when the
 * binding is reached through a receiver — a namespace import, or the
 * object a member is read from. Replacing only the identifier in
 * `units.STEP` would leave `units.5`.
 */
export function readExpression(node: ts.Node): ts.Node {
  let current = node;
  while (
    current.parent &&
    ts.isPropertyAccessExpression(current.parent) &&
    current.parent.name === current
  ) {
    current = current.parent;
  }
  return current;
}
