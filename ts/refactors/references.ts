import path from 'node:path';
import ts from 'typescript';
import type { TsProjectSession } from '../project/index.js';
import { unwrapParens } from '../ast/expressions.js';

/**
 * What a reference to a symbol actually does with it.
 *
 * `ReferenceEntry.isWriteAccess` cannot answer this: it reports true
 * for the declaration itself, for an `import { x }` specifier, and for
 * `const { count } = c` — a destructuring *read*. A tool that refuses
 * on it rejects code it could safely transform, and one that trusts it
 * the other way rewrites code it shouldn't. So classification is by
 * parent node, once, here.
 *
 * The kind that matters most is `escape`: the symbol used as a value
 * rather than called or read through. At an escape, arity and shape are
 * checked by assignability, so a signature change compiles and
 * misbehaves — which is why every signature-shaped refactor refuses
 * there instead of trusting the guard.
 */
export type ReferenceKind =
  | 'declaration'
  | 'import-binding'
  | 'export-specifier'
  | 'read'
  | 'write'
  | 'compound-write'
  | 'destructure-read'
  | 'destructure-write'
  | 'direct-call'
  | 'new'
  | 'escape'
  | 'spread-call'
  | 'type-position';

export interface ClassifiedReference {
  file: string;
  line: number;
  character: number;
  offset: number;
  kind: ReferenceKind;
  /** The identifier node, for tools that need to walk from it. */
  node: ts.Node;
}

/** Kinds that are the symbol's own declaration rather than a use. */
const DECLARING: ReadonlySet<ReferenceKind> = new Set<ReferenceKind>([
  'declaration',
  'import-binding',
  'export-specifier',
]);

export function isUse(reference: ClassifiedReference): boolean {
  return !DECLARING.has(reference.kind);
}

/** Whether a reference writes to the symbol. */
export function isWrite(reference: ClassifiedReference): boolean {
  return (
    reference.kind === 'write' ||
    reference.kind === 'compound-write' ||
    reference.kind === 'destructure-write'
  );
}

function nodeAtOffset(sourceFile: ts.SourceFile, offset: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (node.getStart(sourceFile) <= offset && offset < node.getEnd()) {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node)) {
        found = node;
      }
      node.forEachChild(visit);
    }
  };
  visit(sourceFile);
  return found;
}

/** The nearest ancestor that isn't just a parenthesis or an as-cast. */
function effectiveParent(node: ts.Node): ts.Node | undefined {
  let current = node.parent as ts.Node | undefined;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.parent;
  }
  return current;
}

/** The expression the reference forms, climbing property accesses. */
function referencedExpression(node: ts.Node): ts.Node {
  let current: ts.Node = node;
  while (
    current.parent &&
    ((ts.isPropertyAccessExpression(current.parent) && current.parent.name === current) ||
      (ts.isElementAccessExpression(current.parent) && current.parent.argumentExpression === current))
  ) {
    current = current.parent;
  }
  return current;
}

function classifyNode(node: ts.Node, callable: ReadonlySet<string>): ReferenceKind {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) return 'read';

  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) {
    return 'import-binding';
  }
  if (ts.isExportSpecifier(parent)) return 'export-specifier';
  if (
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isMethodSignature(parent) && parent.name === node) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
    (ts.isEnumDeclaration(parent) && parent.name === node) ||
    (ts.isEnumMember(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node)
  ) {
    return 'declaration';
  }

  // Type position: a reference in a type annotation, heritage clause,
  // or type argument is not a value use at all.
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (
      ts.isTypeNode(current) ||
      ts.isTypeQueryNode(current) ||
      ts.isHeritageClause(current) ||
      ts.isTypeParameterDeclaration(current)
    ) {
      // `typeof f` reads the function's type, and a signature change
      // silently changes what that type means, so it escapes.
      return ts.isTypeQueryNode(current) ? 'escape' : 'type-position';
    }
    if (ts.isExpressionStatement(current) || ts.isBlock(current)) break;
  }

  const expression = referencedExpression(node);
  const outer = effectiveParent(expression);
  if (!outer) return 'read';

  // Destructuring in a binding position — `const { count } = c` — reads
  // the property, whatever `isWriteAccess` says about it. Destructuring
  // *assignment* (`({ count } = c)`) parses as an object literal
  // instead, and is caught by the shorthand-property case below.
  if (
    ts.isBindingElement(outer) ||
    ts.isObjectBindingPattern(outer) ||
    ts.isArrayBindingPattern(outer)
  ) {
    return 'destructure-read';
  }
  if (ts.isShorthandPropertyAssignment(outer) && ts.isObjectLiteralExpression(outer.parent)) {
    const assignment = effectiveParent(outer.parent);
    if (assignment && ts.isBinaryExpression(assignment) && assignment.left === outer.parent) {
      return 'destructure-write';
    }
  }

  if (ts.isBinaryExpression(outer) && unwrapParens(outer.left) === expression) {
    if (outer.operatorToken.kind === ts.SyntaxKind.EqualsToken) return 'write';
    const token = outer.operatorToken.kind;
    if (
      token >= ts.SyntaxKind.FirstCompoundAssignment &&
      token <= ts.SyntaxKind.LastCompoundAssignment
    ) {
      return 'compound-write';
    }
  }
  if (
    (ts.isPostfixUnaryExpression(outer) || ts.isPrefixUnaryExpression(outer)) &&
    (outer.operator === ts.SyntaxKind.PlusPlusToken ||
      outer.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return 'compound-write';
  }

  if (ts.isCallExpression(outer) && unwrapParens(outer.expression) === expression) {
    return outer.arguments.some((argument) => ts.isSpreadElement(argument))
      ? 'spread-call'
      : 'direct-call';
  }
  if (ts.isNewExpression(outer) && unwrapParens(outer.expression) === expression) return 'new';

  // `f.call(...)`, `f.apply(...)`, `f.bind(...)` — the receiver moves,
  // so positional rewriting no longer describes the call.
  if (
    ts.isPropertyAccessExpression(outer) &&
    unwrapParens(outer.expression) === expression &&
    ['call', 'apply', 'bind'].includes(outer.name.text)
  ) {
    return 'escape';
  }

  if (ts.isTaggedTemplateExpression(outer) && outer.tag === expression) return 'escape';
  if (ts.isDecorator(outer)) return 'escape';
  if (ts.isJsxOpeningElement(outer) || ts.isJsxSelfClosingElement(outer) || ts.isJsxClosingElement(outer)) {
    return 'escape';
  }

  // Anything else in value position — an argument, an array element, a
  // property value, a return — hands the symbol out as a value.
  if (
    ts.isCallExpression(outer) ||
    ts.isNewExpression(outer) ||
    ts.isArrayLiteralExpression(outer) ||
    ts.isPropertyAssignment(outer) ||
    ts.isReturnStatement(outer) ||
    ts.isArrowFunction(outer) ||
    ts.isVariableDeclaration(outer) ||
    ts.isExportAssignment(outer)
  ) {
    // Handing a callable out as a value puts its signature under
    // assignability checking, where a change compiles and misbehaves.
    return ts.isIdentifier(node) && callable.has(node.text) ? 'escape' : 'read';
  }

  return 'read';
}

export interface ClassifyOptions {
  /**
   * Names known to be callable. References to these in value position
   * classify as `escape` rather than `read`.
   */
  callable?: ReadonlySet<string>;
}

/**
 * Every reference to the symbol declared at `offset` in `file`,
 * classified. Includes the declaration itself.
 */
export function classifyReferences(
  session: TsProjectSession,
  file: string,
  offset: number,
  options: ClassifyOptions = {},
): ClassifiedReference[] {
  const callable = options.callable ?? new Set<string>();
  const service = session.languageService().service;
  const program = session.program();
  const groups = service.findReferences(file, offset) ?? [];

  const classified: ClassifiedReference[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const entry of group.references) {
      const entryFile = path.resolve(entry.fileName);
      const key = `${entryFile}:${entry.textSpan.start}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const sourceFile = program.getSourceFile(entryFile);
      if (!sourceFile) continue;
      const node = nodeAtOffset(sourceFile, entry.textSpan.start);
      if (!node) continue;
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(entry.textSpan.start);
      classified.push({
        file: entryFile,
        line,
        character,
        offset: entry.textSpan.start,
        kind: classifyNode(node, callable),
        node,
      });
    }
  }
  return classified;
}
