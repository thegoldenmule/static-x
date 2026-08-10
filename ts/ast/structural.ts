import ts from 'typescript';

/**
 * Two ways of asking whether two pieces of syntax are the same, for the
 * two questions the repo actually asks.
 *
 * `shapeKey` ignores names and literal values, so a renamed copy of a
 * function still collides — the question `ts/dupes/functions` asks.
 * `tokenKey` keeps them, so equality means the code compiles
 * identically — the question "does every caller pass the same value?"
 * asks. Neither is derivable from the other, and using the wrong one is
 * the kind of mistake that produces a confidently wrong refactoring.
 */

function isJSDoc(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

/**
 * Every SyntaxKind in the subtree, preorder, paired with its child
 * count. The child count makes the key an injective encoding of the
 * tree — flat kind sequences alone cannot tell nesting from siblings,
 * e.g. `f(g(x), y)` from `f(g(x, y))`. JSDoc subtrees are skipped so
 * documentation never changes the shape.
 */
export function shapeKey(node: ts.Node): { key: string; nodes: number } {
  const entries: string[] = [];
  const visit = (current: ts.Node): number => {
    if (isJSDoc(current)) return 0;
    const slot = entries.length;
    entries.push('');
    let children = 0;
    ts.forEachChild(current, (child) => {
      children += visit(child);
    });
    entries[slot] = `${String(current.kind)}:${String(children)}`;
    return 1;
  };
  visit(node);
  return { key: entries.join(','), nodes: entries.length };
}

/**
 * The subtree reduced to its tokens, joined. Tokens carry string and
 * template contents verbatim while comments and layout are trivia and
 * drop out, so equality means the code compiles identically. Raw-text
 * whitespace collapsing would get both directions wrong: it conflates
 * literals that differ only in inner whitespace and lets a comment
 * break exactness.
 */
export function tokenKey(node: ts.Node, sourceFile: ts.SourceFile): string {
  const tokens: string[] = [];
  const visit = (current: ts.Node): void => {
    if (isJSDoc(current)) return;
    const children = current.getChildren(sourceFile);
    if (children.length === 0) {
      const text = current.getText(sourceFile);
      if (text.length > 0) tokens.push(text);
      return;
    }
    for (const child of children) visit(child);
  };
  visit(node);
  return tokens.join(' ');
}

/**
 * Whether two nodes are the same code. Compares tokens, so `f(1)` and
 * `f( 1 )` match while `f(1)` and `f(2)` do not.
 */
export function sameCode(
  a: { node: ts.Node; sourceFile: ts.SourceFile },
  b: { node: ts.Node; sourceFile: ts.SourceFile },
): boolean {
  return tokenKey(a.node, a.sourceFile) === tokenKey(b.node, b.sourceFile);
}
