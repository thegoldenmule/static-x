import ts from 'typescript';

/** The expression inside any number of wrapping parentheses. */
export function unwrapParens(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}
