import crypto from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import type { Finding, Range, Tool } from '../../../core/tool/index.js';
import { FINDINGS_ARRAY_SCHEMA } from '../../../core/tool/index.js';
import type { TsProjectSession } from '../../project/index.js';
import { isTestFile, toProjectRelative } from '../../project/index.js';

/**
 * Finds structurally identical function bodies (dupes.function) by
 * hashing the preorder SyntaxKind:childCount sequence of each body
 * subtree. Identifier text and literal values are not part of the key,
 * so renamed copies still collide; the token-normalized body text then
 * separates exact copies from merely parallel structure.
 */

export interface DupeFunctionsInput {
  /** Ignore functions whose body subtree has fewer nodes. Default 35. */
  minNodes?: number;
  /**
   * Also scan `*.test.ts(x)` / `*.spec.ts(x)` files. Default false:
   * duplicate test setup is usually deliberate.
   */
  includeTests?: boolean;
}

/** One function with a body, reduced to what duplicate grouping needs. */
export interface FunctionShape {
  /** Preorder SyntaxKind:childCount sequence of the body subtree, joined. */
  key: string;
  /** Declared or inferred name, or '(anonymous)'. */
  name: string;
  /** The whole function, leading JSDoc excluded. */
  range: Range;
  /** Node count of the body subtree. */
  nodes: number;
  /** Body tokens joined; equality means the bodies compile identically. */
  normalizedText: string;
}

const DEFAULT_MIN_NODES = 35;
const ANONYMOUS = '(anonymous)';

type SupportedFunction =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

/**
 * Getters/setters are excluded deliberately (accessor boilerplate),
 * and so are constructors — they do have bodies, but the bodies are
 * conventionally parallel injection/assignment boilerplate. Overload
 * signatures and ambient declarations have no body to compare.
 */
function isSupportedFunction(node: ts.Node): node is SupportedFunction {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/**
 * `parent` is threaded in by the collector's own walk: program-parsed
 * source files leave `node.parent` unset until the checker binds them,
 * so reading `node.parent` here would (nondeterministically) lose the
 * names of arrows and property-assigned function expressions.
 */
function functionName(
  node: SupportedFunction,
  parent: ts.Node | undefined,
  sourceFile: ts.SourceFile,
): string {
  if (!ts.isArrowFunction(node) && node.name !== undefined) {
    return node.name.getText(sourceFile);
  }
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent !== undefined && ts.isPropertyAssignment(parent)) {
    return parent.name.getText(sourceFile);
  }
  return ANONYMOUS;
}

/**
 * The structural key: every SyntaxKind in the body subtree, preorder,
 * each paired with its child count. The child count makes the key an
 * injective encoding of the tree — flat kind sequences alone cannot
 * tell nesting from siblings, e.g. `f(g(x), y)` from `f(g(x, y))`.
 * JSDoc subtrees are skipped so documentation never changes the shape.
 */
function bodyShape(body: ts.Node): { key: string; nodes: number } {
  const entries: string[] = [];
  const visit = (node: ts.Node): number => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return 0;
    }
    const slot = entries.length;
    entries.push('');
    let children = 0;
    ts.forEachChild(node, (child) => {
      children += visit(child);
    });
    entries[slot] = `${String(node.kind)}:${String(children)}`;
    return 1;
  };
  visit(body);
  return { key: entries.join(','), nodes: entries.length };
}

/**
 * The body reduced to its tokens, joined. Tokens carry string and
 * template contents verbatim while comments and layout are trivia and
 * drop out, so equality means the bodies compile identically. Raw-text
 * whitespace collapsing would get both directions wrong: it conflates
 * literals that differ only in inner whitespace and lets a comment
 * break exactness.
 */
function normalizedBodyText(body: ts.Node, sourceFile: ts.SourceFile): string {
  const tokens: string[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      const text = node.getText(sourceFile);
      if (text.length > 0) tokens.push(text);
      return;
    }
    for (const child of children) visit(child);
  };
  visit(body);
  return tokens.join(' ');
}

/**
 * Every function declaration, function expression, arrow function, and
 * method in the file whose body subtree has at least `minNodes` nodes,
 * reduced to its comparable shape. Nested functions are collected in
 * their own right and also remain part of the enclosing body's shape,
 * so a pasted outer function yields findings for its inner functions
 * too. Pure over the source file; grouping across files happens in the
 * tool's `run`.
 */
export function collectFunctionShapes(
  sourceFile: ts.SourceFile,
  input: DupeFunctionsInput = {},
): FunctionShape[] {
  const minNodes = input.minNodes ?? DEFAULT_MIN_NODES;
  const shapes: FunctionShape[] = [];
  const visit = (node: ts.Node, parent: ts.Node | undefined): void => {
    if (isSupportedFunction(node) && node.body !== undefined) {
      const { key, nodes } = bodyShape(node.body);
      if (nodes >= minNodes) {
        shapes.push({
          key,
          name: functionName(node, parent, sourceFile),
          range: {
            start: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)),
            end: sourceFile.getLineAndCharacterOfPosition(node.getEnd()),
          },
          nodes,
          normalizedText: normalizedBodyText(node.body, sourceFile),
        });
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, node);
    });
  };
  visit(sourceFile, undefined);
  return shapes;
}

interface LocatedShape extends FunctionShape {
  file: string;
}

function byFileThenPosition(a: LocatedShape, b: LocatedShape): number {
  return a.file < b.file
    ? -1
    : a.file > b.file
      ? 1
      : a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
}

export const dupeFunctions: Tool<DupeFunctionsInput, Finding[], TsProjectSession> = {
  name: 'ts/dupes/functions',
  description:
    'Finds structurally identical function bodies (dupes.function) by hashing the AST shape of each body — ' +
    'identifier names and literal values excluded — so renamed copies still match. Only ' +
    'bodies are compared: signatures, modifiers (async, generators), and return types are ' +
    'not part of the key. Exact duplicates (identical body tokens; formatting and comments ' +
    'aside) are warnings at high confidence: extract one shared implementation. ' +
    'Structural-only matches are info at medium confidence: same shape with different ' +
    'identifiers, which is sometimes legitimately parallel code. Each member of a duplicate ' +
    'group gets its own finding listing its peers. Small functions below minNodes and test ' +
    'files are skipped by default.',
  inputSchema: {
    type: 'object',
    properties: {
      minNodes: {
        type: 'integer',
        minimum: 1,
        description: 'Minimum body-subtree node count for a function to participate (default 35)',
      },
      includeTests: {
        type: 'boolean',
        description: 'Also scan *.test.ts(x) / *.spec.ts(x) files (default false)',
      },
    },
    additionalProperties: false,
  },
  outputSchema: FINDINGS_ARRAY_SCHEMA,
  run(session, input) {
    const includeTests = input.includeTests ?? false;
    const groups = new Map<string, LocatedShape[]>();
    for (const sourceFile of session.sourceFiles()) {
      if (!includeTests && isTestFile(sourceFile.fileName)) continue;
      const file = path.resolve(sourceFile.fileName);
      for (const shape of collectFunctionShapes(sourceFile, input)) {
        let members = groups.get(shape.key);
        if (!members) {
          members = [];
          groups.set(shape.key, members);
        }
        members.push({ ...shape, file });
      }
    }

    const relative = (file: string): string => toProjectRelative(session.rootPath, file);
    const findings: Finding[] = [];
    for (const [key, members] of groups) {
      if (members.length < 2) continue;
      members.sort(byFileThenPosition);
      const group = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
      for (const member of members) {
        const others = members.filter((m) => m !== member);
        const peers = others.map((m) => ({
          file: relative(m.file),
          // 1-based for humans, unlike the 0-based finding range.
          line: m.range.start.line + 1,
        }));
        const exact = others.some((m) => m.normalizedText === member.normalizedText);
        const where = peers.map((p) => `${p.file}:${String(p.line)}`).join(', ');
        const label = peers.length === 1 ? 'peer' : 'peers';
        const message = exact
          ? `Function '${member.name}' has an exact duplicate — same body tokens; formatting ` +
            `and comments aside — among ${String(peers.length)} ${label}: ${where}. ` +
            'Duplicated bodies drift apart silently; extract one shared implementation ' +
            'and import it.'
          : `Function '${member.name}' is structurally identical to ${String(peers.length)} ` +
            `${label}: ${where}. Same body shape with different identifiers or literals — if ` +
            'they implement the same logic, unify them; if legitimately parallel, ignore.';
        findings.push({
          file: member.file,
          range: member.range,
          code: 'dupes.function',
          message,
          severity: exact ? 'warning' : 'info',
          data: {
            // File-qualified fallback so one static-x.json ignore entry
            // never silences every anonymous duplicate in the project.
            name:
              member.name === ANONYMOUS ? `${relative(member.file)}:${ANONYMOUS}` : member.name,
            kind: exact ? 'exact' : 'structural',
            group,
            peers,
            nodes: member.nodes,
            exact,
            confidence: exact ? 'high' : 'medium',
          },
        });
      }
    }
    return Promise.resolve(
      findings.sort(
        (a, b) =>
          (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
          a.range.start.line - b.range.start.line ||
          a.range.start.character - b.range.start.character,
      ),
    );
  },
};
