import ts from 'typescript';

/**
 * Original declaration sites only — not usages, and not import/export
 * specifiers (those are aliases of a symbol declared elsewhere).
 */
export function isDeclarationSite(node: ts.Node): node is ts.NamedDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isPropertySignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isModuleDeclaration(node)
  );
}

/** Every identifier-named declaration in a file, by name. */
export function declaredNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (isDeclarationSite(node) && node.name && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return names;
}

/** The deepest node whose full range contains `position`. */
export function nodeAt(sourceFile: ts.SourceFile, position: number): ts.Node {
  let best: ts.Node = sourceFile;
  const visit = (node: ts.Node) => {
    if (node.getFullStart() <= position && position < node.getEnd()) {
      best = node;
      node.forEachChild(visit);
    }
  };
  visit(sourceFile);
  return best;
}
