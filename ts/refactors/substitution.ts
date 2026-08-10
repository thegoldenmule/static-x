import ts from 'typescript';

/**
 * Putting one expression where another used to be.
 *
 * Every inline refactoring is this operation plus a decision about when
 * it is safe, and all three ways it goes wrong are invisible to a
 * typecheck — TypeScript's own `Inline variable` demonstrates each:
 *
 * - **Precedence.** It parenthesizes on precedence rank alone with no
 *   test for operand position, so `const d = a - b; return c - d`
 *   becomes `return c - a - b`. Both compile; one is wrong.
 * - **Capture.** It performs no scope check, so an expression naming
 *   `a` moved into a block that declares its own `a` silently rebinds.
 * - **Purity.** It performs no purity check, so `const v = bump()` used
 *   three times becomes three calls.
 *
 * The precedence half is not hand-rolled here. Building the result with
 * the compiler's own factory and printing it applies TypeScript's
 * parenthesizer rules, which are the authority on where parentheses are
 * required — and getting them from the compiler means they cannot drift
 * from what the compiler thinks. The other two halves are the caller's
 * to enforce; this module supplies what they need to decide.
 */

/**
 * The result of substituting `bindings` into `body`, as source text.
 *
 * Arguments are spliced in defensively parenthesized and the whole
 * expression is re-parsed as one unit — so every node shares a source
 * file, which is what makes literals survive printing — then the
 * parentheses are stripped and the factory re-adds exactly the ones
 * required. Wrapping first and unwrapping after is what lets the
 * compiler decide, rather than this code guessing.
 *
 * `bindings` maps a parameter name to the argument's source text.
 */
export function substituteExpression(
  body: ts.Expression,
  bodyFile: ts.SourceFile,
  bindings: ReadonlyMap<string, string>,
): { text: string; expression: ts.Expression } {
  const replacements: { start: number; end: number; text: string }[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && bindings.has(node.text) && !isNamePosition(node)) {
      replacements.push({
        start: node.getStart(bodyFile),
        end: node.getEnd(),
        text: `(${bindings.get(node.text)!})`,
      });
    }
    ts.forEachChild(node, collect);
  };
  collect(body);

  const base = body.getStart(bodyFile);
  let text = body.getText(bodyFile);
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    text =
      text.slice(0, replacement.start - base) + replacement.text + text.slice(replacement.end - base);
  }

  const parsed = ts.createSourceFile('__inline.ts', `${text};`, ts.ScriptTarget.Latest, true);
  const statement = parsed.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) {
    throw new Error('The substituted body does not parse as a single expression');
  }
  const unwrapped = ts.transform(statement.expression, [
    (context) => (root) => {
      const visit = (node: ts.Node): ts.Node => {
        const visited = ts.visitEachChild(node, visit, context);
        return ts.isParenthesizedExpression(visited) ? visited.expression : visited;
      };
      return ts.visitNode(root, visit) as ts.Expression;
    },
  ]).transformed[0];
  if (!unwrapped) throw new Error('The substituted body could not be printed');

  return {
    text: ts
      .createPrinter({ newLine: ts.NewLineKind.LineFeed })
      .printNode(ts.EmitHint.Expression, unwrapped, parsed),
    expression: unwrapped,
  };
}

/**
 * Whether an expression put where `site` currently sits needs wrapping.
 *
 * The parenthesizer that builds the substituted text only sees inside
 * it; it cannot know the result lands as the right operand of a
 * subtraction. That is the same failure in the other direction — a body
 * of `a - b` spliced into `c - f()` gives `c - a - b` unless something
 * asks this question — so it is asked explicitly rather than left to a
 * printer that has no way to answer it.
 *
 * The rule is two-sided and deliberately conservative. An expression
 * that binds tighter than anything can pull apart needs nothing, and a
 * position already delimited by a bracket, a comma or a keyword needs
 * nothing either. Everything else is wrapped, which is occasionally one
 * pair of parentheses more than a person would write and never one
 * fewer than correctness requires.
 */
export function needsParentheses(inlined: ts.Expression, site: ts.Node): boolean {
  if (isPrimary(inlined)) return false;

  const parent = site.parent as ts.Node | undefined;
  if (!parent) return false;
  if (
    ts.isExpressionStatement(parent) ||
    ts.isReturnStatement(parent) ||
    ts.isParenthesizedExpression(parent) ||
    ts.isTemplateSpan(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.expression !== site)
  ) {
    return false;
  }
  return true;
}

/** Expressions no operator can split apart. */
function isPrimary(expression: ts.Expression): boolean {
  return (
    ts.isIdentifier(expression) ||
    ts.isLiteralExpression(expression) ||
    ts.isCallExpression(expression) ||
    ts.isNewExpression(expression) ||
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isArrayLiteralExpression(expression) ||
    ts.isTemplateExpression(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isTaggedTemplateExpression(expression) ||
    expression.kind === ts.SyntaxKind.ThisKeyword ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  );
}

/** An identifier that names something rather than referring to it. */
function isNamePosition(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) return false;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isQualifiedName(parent) && parent.right === node)
  );
}

/**
 * The outermost identifiers an expression depends on — `a` and `c` in
 * `a.b + c(1)`. These are the names whose meaning has to be the same
 * wherever the expression is moved to.
 */
export function rootIdentifiers(expression: ts.Node): ts.Identifier[] {
  const roots: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression);
      return;
    }
    if (ts.isIdentifier(node)) {
      roots.push(node);
      return;
    }
    node.forEachChild(visit);
  };
  visit(expression);
  return roots;
}

export function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/**
 * Whether evaluating this expression could do something observable.
 * Duplicating such an expression changes how many times it happens, and
 * dropping one changes whether it happens at all — neither of which a
 * typecheck notices.
 */
export function mayHaveEffects(expression: ts.Node): boolean {
  let effectful = false;
  const visit = (node: ts.Node): void => {
    if (effectful) return;
    if (
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
    ) {
      effectful = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(expression);
  return effectful;
}

export interface CaptureConflict {
  name: string;
  reason: 'missing' | 'different';
}

/**
 * Names in `expression` that would mean something else — or nothing —
 * if the expression were evaluated at `site` instead.
 *
 * This is the check the guard cannot make for us. A name that resolves
 * nowhere at the destination is a compile error the guard would catch;
 * a name that resolves to a *different* symbol compiles perfectly and
 * silently means something else, which is the whole reason for the
 * check being here rather than left to the typecheck.
 */
export function captureConflicts(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  site: ts.Node,
  ignore: ReadonlySet<string>,
): CaptureConflict[] {
  const atSite = new Map<string, ts.Symbol>();
  for (const symbol of checker.getSymbolsInScope(site, ts.SymbolFlags.Value | ts.SymbolFlags.Type)) {
    if (!atSite.has(symbol.name)) atSite.set(symbol.name, unalias(checker, symbol));
  }

  const conflicts: CaptureConflict[] = [];
  const seen = new Set<string>();
  for (const identifier of rootIdentifiers(expression)) {
    if (ignore.has(identifier.text) || seen.has(identifier.text)) continue;
    seen.add(identifier.text);

    const declared = checker.getSymbolAtLocation(identifier);
    if (!declared) continue;
    const here = unalias(checker, declared);
    const there = atSite.get(identifier.text);
    if (!there) conflicts.push({ name: identifier.text, reason: 'missing' });
    else if (there !== here) conflicts.push({ name: identifier.text, reason: 'different' });
  }
  return conflicts;
}
