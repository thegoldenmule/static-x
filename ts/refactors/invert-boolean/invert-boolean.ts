import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { unwrapParens } from '../../ast/expressions.js';
import { memberHierarchy } from '../../ast/hierarchy.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences, type ClassifiedReference } from '../references.js';
import { rename } from '../rename/rename.js';
import {
  argumentIndexOf,
  assertOnlyCalls,
  callableOf,
  callLikeOf,
  locationOf,
  resolveCall,
  surveyCallSites,
  type CallableDeclaration,
} from '../signatures.js';
import { mergeWorkspaceEdits } from '../text-changes.js';

/**
 * Flips the sense of a boolean function, variable, property or
 * parameter — ReSharper's Invert Boolean. Returns and assignments are
 * negated, every read is negated, and the declaration is optionally
 * renamed to match (`isVisible` → `isHidden`).
 *
 * **The soundness condition is the tool.** `!x` is an inversion of `x`
 * only when `x` is a boolean. TypeScript coerces anything to a truth
 * value, so for `boolean | undefined` — the ordinary shape of an
 * optional flag — `!x` maps `false` and `undefined` to the same `true`,
 * collapsing a three-valued domain onto two. That is not an edge case
 * to warn about; it is the failure this refactoring exists to avoid,
 * and it compiles green either way. So the checker is asked whether the
 * type is *exactly* `boolean`, and everything else is refused before an
 * edit is built.
 *
 * **The guard is blind here, uniquely so.** Every site this rewrites is
 * boolean before and after, so `diagnosticsIntroducedBy` proves the edit
 * still compiles and nothing whatsoever about it still meaning the same
 * thing. It runs anyway — the rename half *is* guard-visible — but the
 * safety in this tool is the exact type test plus a refusal for every
 * reference it cannot rewrite. No reference is silently left alone.
 *
 * Negation is structural, not textual. A double negative collapses, an
 * equality flips to its exact complement, a literal `true` becomes
 * `false`, and where a `!` has to be inserted the compiler's own
 * parenthesizer decides the brackets. Relational operators are
 * deliberately *not* flipped: `!(a < b)` is not `a >= b` when either
 * side is `NaN`.
 */

export interface InvertBooleanInput {
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  /** Rename the declaration as well, through `ts/refactors/rename`. */
  newName?: string;
  apply?: boolean;
}

/** What a rewritten site was doing with the value. */
export type InvertSiteKind = 'return' | 'call' | 'read' | 'write' | 'initializer' | 'argument';

export interface InvertSite {
  file: string;
  /** Zero-based, matching every other position in this repo. */
  line: number;
  character: number;
  kind: InvertSiteKind;
}

export interface InvertBooleanOutput extends RefactorOutput {
  /** Every expression the edit negates. */
  sites: InvertSite[];
}

/**
 * `boolean` is interned as the union `true | false` carrying
 * `TypeFlags.Boolean` on the union itself, so this one bit separates it
 * from every neighbour: `boolean | undefined` is a plain `Union`, a
 * `const` initialised `true` is a `BooleanLiteral`, and a constrained
 * type parameter is a `TypeParameter`. Measured against the checker, not
 * assumed — an `!x` written for any of those three is a silent change of
 * meaning that compiles.
 */
function isExactlyBoolean(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Boolean) !== 0;
}

/**
 * The exact complements. `===`/`!==` and `==`/`!=` partition every pair
 * of values between them, `NaN` included, so flipping the token is the
 * same expression as negating the whole comparison.
 *
 * Relational operators are absent on purpose. `a < b` and `a >= b` are
 * *both* false when either operand is `NaN`, so rewriting `!(a < b)` as
 * `a >= b` changes the answer — quietly, and only for the inputs nobody
 * tests with. Those get a `!` like anything else.
 */
const EQUALITY_COMPLEMENT = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.EqualsEqualsEqualsToken, '!=='],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, '==='],
  [ts.SyntaxKind.EqualsEqualsToken, '!='],
  [ts.SyntaxKind.ExclamationEqualsToken, '=='],
]);

/** The expression a reference denotes, climbing property accesses. */
function valueExpressionOf(node: ts.Node): ts.Expression {
  let current: ts.Node = node;
  while (
    current.parent &&
    ((ts.isPropertyAccessExpression(current.parent) && current.parent.name === current) ||
      (ts.isElementAccessExpression(current.parent) &&
        current.parent.argumentExpression === current))
  ) {
    current = current.parent;
  }
  return current as ts.Expression;
}

/** The node above `expression`, ignoring wrappers that erase at runtime. */
function outerExpression(expression: ts.Node): ts.Node | undefined {
  let current: ts.Node = expression;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  ) {
    current = current.parent;
  }
  return current.parent;
}

/** The `!` applied directly to `expression`, if there is one. */
function enclosingNegation(expression: ts.Expression): ts.PrefixUnaryExpression | undefined {
  let current: ts.Node = expression;
  while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent;
  const parent: ts.Node | undefined = current.parent;
  return parent !== undefined &&
    ts.isPrefixUnaryExpression(parent) &&
    parent.operator === ts.SyntaxKind.ExclamationToken &&
    parent.operand === current
    ? parent
    : undefined;
}

/** The `x = …` this reference is the target of. */
function assignmentOf(value: ts.Expression): ts.BinaryExpression | undefined {
  const parent = outerExpression(value);
  if (!parent || !ts.isBinaryExpression(parent)) return undefined;
  if (parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
  return unwrapParens(parent.left) === value || parent.left === value ? parent : undefined;
}

/**
 * Whether anything consumes the *value* of an assignment.
 *
 * `flag = compute()` as a statement throws its value away, so negating
 * the right-hand side is the whole edit. `if ((flag = compute()))`
 * branches on it, and negating the right-hand side would invert the
 * branch as well — a second meaning changed for free, invisible to a
 * typecheck. Chained assignment (`a = b = expr`) is the same problem one
 * level in.
 */
function assignmentValueIsUsed(assignment: ts.BinaryExpression): boolean {
  let current: ts.Node = assignment;
  while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent;
  const parent: ts.Node | undefined = current.parent;
  if (!parent) return true;
  if (ts.isExpressionStatement(parent)) return false;
  if (ts.isForStatement(parent) && (parent.initializer === current || parent.incrementor === current)) {
    return false;
  }
  // A comma expression's non-final operands are evaluated and discarded.
  return !(ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.CommaToken);
}

/**
 * Whether the compiler's parenthesizer brackets `replacement` when it is
 * put where `site` sits.
 *
 * Asked by rebuilding the parent with the replacement spliced in:
 * `visitEachChild` routes through the same `factory.updateX` calls the
 * emitter uses, so the answer is TypeScript's rule rather than a table of
 * precedences maintained here. `!x` needs brackets in exactly the
 * positions that demand a left-hand-side expression — `(!x).toString()`,
 * `(!x)!` — and nowhere else, which is why `needsParentheses` from
 * `substitution.ts`, built to be conservative for arbitrary inlined
 * expressions, is one pair too eager for this one.
 */
function wrapsWhenPlaced(site: ts.Expression, replacement: ts.Expression): boolean {
  const parent = site.parent as ts.Node | undefined;
  // Already delimited by the brackets that are in the source.
  if (!parent || ts.isParenthesizedExpression(parent)) return false;

  let wrapped = false;
  const result = ts.transform(parent, [
    (context) => (root) => {
      const updated = ts.visitEachChild(
        root,
        (child) => (child === site ? replacement : child),
        context,
      );
      const find = (node: ts.Node): void => {
        if (ts.isParenthesizedExpression(node) && node.expression === replacement) wrapped = true;
        node.forEachChild(find);
      };
      find(updated);
      return updated;
    },
  ]);
  result.dispose();
  return wrapped;
}

interface Planned {
  kind: InvertSiteKind;
  /** The expression whose value the edit negates. */
  target: ts.Expression;
  /**
   * Value sites are planned first, so that when a value site and a use
   * site both want to cancel the same `!` the value site gets it. Both
   * orders are correct; only one is tidy. `x = !x` is the case: the write
   * cancels the `!` and the read inside re-inserts one, leaving the
   * toggle exactly as it was.
   */
  phase: 0 | 1;
}

/** Negating is bookkeeping over which `!` tokens are already spoken for. */
interface Negator {
  checker: ts.TypeChecker;
  claimed: Set<string>;
}

function tokenKey(sourceFile: ts.SourceFile, node: ts.Node): string {
  return `${sourceFile.fileName}:${String(node.getStart(sourceFile))}`;
}

/**
 * The edits that negate the value of `target`, as token-level changes.
 *
 * Every branch here deliberately avoids touching an identifier: a `!` is
 * deleted, an operator or a keyword is replaced, or a bracket and a `!`
 * are *inserted* at the expression's boundaries. That is what lets a
 * rename be merged into the same WorkspaceEdit — the rename rewrites
 * identifier spans and nothing else, so the two edit sets are disjoint by
 * construction rather than by luck.
 */
function negationEdits(negator: Negator, target: ts.Expression): TextEdit[] {
  const sourceFile = target.getSourceFile();
  const at = (offset: number): { line: number; character: number } =>
    sourceFile.getLineAndCharacterOfPosition(offset);
  const bare = unwrapParens(target);

  const cancel = (bang: ts.PrefixUnaryExpression): TextEdit[] | undefined => {
    const key = tokenKey(sourceFile, bang);
    if (negator.claimed.has(key)) return undefined;
    negator.claimed.add(key);

    // Brackets that were only holding the `!` apart from its surroundings
    // go with it. Without this they accumulate — `(!x)` in a receiver
    // position would leave `(x)`, `!(a && b)` would leave `(a && b)` —
    // and the tool stops being its own inverse. Which brackets those are
    // is the parenthesizer's question again, asked twice: first for the
    // operand's own pair, then for the enclosing one, so that
    // `(!(a && b)).toString()` keeps exactly one of them.
    let kept: ts.Expression = bang.operand;
    if (ts.isParenthesizedExpression(kept) && !wrapsWhenPlaced(bang, kept.expression)) {
      kept = kept.expression;
    }
    const parent = bang.parent as ts.Node | undefined;
    const removed: ts.Expression =
      parent !== undefined &&
      ts.isParenthesizedExpression(parent) &&
      parent.expression === bang &&
      !wrapsWhenPlaced(parent, kept)
        ? parent
        : bang;

    const edits: TextEdit[] = [
      {
        range: { start: at(removed.getStart(sourceFile)), end: at(kept.getStart(sourceFile)) },
        newText: '',
      },
    ];
    if (kept.getEnd() < removed.getEnd()) {
      edits.push({ range: { start: at(kept.getEnd()), end: at(removed.getEnd()) }, newText: '' });
    }
    return edits;
  };

  // `!e` → `e`, but only when `e` is itself a boolean: `!!s` on a string
  // is a coercion, and dropping it changes the type rather than the sense.
  if (
    ts.isPrefixUnaryExpression(bare) &&
    bare.operator === ts.SyntaxKind.ExclamationToken &&
    isExactlyBoolean(negator.checker.getTypeAtLocation(bare.operand))
  ) {
    const edits = cancel(bare);
    if (edits) return edits;
  }

  // `!x` → `x`, where the `!` belongs to the surrounding code.
  const enclosing = enclosingNegation(target);
  if (enclosing) {
    const edits = cancel(enclosing);
    if (edits) return edits;
  }

  if (ts.isBinaryExpression(bare)) {
    const complement = EQUALITY_COMPLEMENT.get(bare.operatorToken.kind);
    if (complement !== undefined) {
      return [
        {
          range: {
            start: at(bare.operatorToken.getStart(sourceFile)),
            end: at(bare.operatorToken.getEnd()),
          },
          newText: complement,
        },
      ];
    }
  }

  if (bare.kind === ts.SyntaxKind.TrueKeyword || bare.kind === ts.SyntaxKind.FalseKeyword) {
    return [
      {
        range: { start: at(bare.getStart(sourceFile)), end: at(bare.getEnd()) },
        newText: bare.kind === ts.SyntaxKind.TrueKeyword ? 'false' : 'true',
      },
    ];
  }

  const negated = ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, target);
  // The factory ran `parenthesizeOperandOfPrefixUnary`; it wrapped the
  // operand iff the result is not the node handed in.
  const inner = negated.operand !== target;
  const outer = wrapsWhenPlaced(target, negated);
  const start = at(target.getStart(sourceFile));
  const end = at(target.getEnd());
  const edits: TextEdit[] = [
    { range: { start, end: start }, newText: `${outer ? '(' : ''}!${inner ? '(' : ''}` },
  ];
  if (inner || outer) {
    edits.push({
      range: { start: end, end },
      newText: `${inner ? ')' : ''}${outer ? ')' : ''}`,
    });
  }
  return edits;
}

/**
 * Fold edits that claim the same range into one.
 *
 * Two sites can legitimately insert at the same offset — `a.flag =
 * b.flag`, where both name the inverted property, negates the read and
 * the stored value at the same boundary — and `applyTextEdits` would
 * apply them in an order it does not promise. Concatenating keeps opening
 * and closing brackets balanced whichever order they were planned in.
 */
function mergeSameRange(changes: Record<string, TextEdit[]>): Record<string, TextEdit[]> {
  const merged: Record<string, TextEdit[]> = {};
  for (const [file, edits] of Object.entries(changes)) {
    const byRange = new Map<string, TextEdit>();
    for (const edit of edits) {
      const { start, end } = edit.range;
      const key = `${String(start.line)}:${String(start.character)}-${String(end.line)}:${String(end.character)}`;
      const existing = byRange.get(key);
      if (existing) existing.newText += edit.newText;
      else byRange.set(key, { ...edit });
    }
    merged[file] = [...byRange.values()];
  }
  return merged;
}

/** Every `return` expression the callable's own body produces. */
function returnExpressions(callable: CallableDeclaration, name: string): ts.Expression[] {
  const body = callable.body;
  if (!body) throw new Error(`"${name}" has no body, so there are no returns to invert`);
  if (!ts.isBlock(body)) return [body];

  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    // A nested callable's returns belong to it, not to us.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassLike(node)
    ) {
      return;
    }
    if (ts.isReturnStatement(node)) {
      if (!node.expression) {
        throw new Error(
          `"${name}" has a bare \`return\` at ${locationOf(node.getSourceFile(), node.getStart())}, ` +
            'which yields undefined rather than a boolean to invert',
        );
      }
      found.push(node.expression);
      return;
    }
    node.forEachChild(visit);
  };
  body.forEachChild(visit);
  return found;
}

/**
 * Whether a reference sits inside a `typeof x` type query.
 *
 * The shared classifier calls this an *escape*, because for a signature
 * refactoring `typeof f` is a place where the change is checked by
 * assignability rather than at a call. Nothing about a signature changes
 * here: `typeof isVisible` is `boolean` before the inversion and
 * `boolean` after it, and `typeof isEnabled` keeps the same parameters
 * and the same return type. The query names a type, never a value, so it
 * is passed over rather than refused.
 */
function isTypeQueryReference(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isTypeQueryNode(current)) return true;
    if (ts.isSourceFile(current) || ts.isBlock(current)) return false;
  }
  return false;
}

/** The name a declaration is written under, for messages. */
function nameOf(declaration: ts.NamedDeclaration): string {
  return declaration.name ? declaration.name.getText(declaration.getSourceFile()) : '(anonymous)';
}

function describeReference(reference: ClassifiedReference): string {
  return `${reference.file}:${String(reference.line + 1)}:${String(reference.character + 1)}`;
}

/** Is the declaration reachable from outside this compilation? */
function isExported(declaration: ts.Node): boolean {
  for (let node: ts.Node | undefined = declaration; node; node = node.parent) {
    if (
      ts.canHaveModifiers(node) &&
      ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export
    ) {
      return true;
    }
    if (ts.isSourceFile(node)) return false;
  }
  return false;
}

/** Refuse a member whose meaning is shared with another declaration. */
function assertSoleDeclaration(
  session: TsProjectSession,
  member: ts.NamedDeclaration,
  name: string,
): void {
  const hierarchy = memberHierarchy(session, member);
  if (hierarchy.unresolved.length > 0) {
    throw new Error(
      `"${name}"'s type hierarchy cannot be resolved (${hierarchy.unresolved.join('; ')}), so a ` +
        'declaration sharing this member may be invisible here',
    );
  }
  const shared = [...hierarchy.supertypes, ...hierarchy.subtypes];
  if (shared.length > 0) {
    throw new Error(
      `"${name}" is declared by other types in its hierarchy, which would keep the old sense ` +
        `while this one flips:\n  ${shared
          .map((entry) => `${entry.container} at ${entry.file}:${String(entry.line + 1)}`)
          .join('\n  ')}`,
    );
  }
}

/** The declaration's own initializer, when it has one. */
function initializerOf(declaration: ts.NamedDeclaration): ts.Expression | undefined {
  if (
    ts.isVariableDeclaration(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isParameter(declaration)
  ) {
    return declaration.initializer;
  }
  return undefined;
}

/**
 * Plan every site for a symbol that *holds* a boolean — a variable, a
 * property, a parameter. Each reference is either rewritten or refused;
 * none is passed over, because a read left un-negated is exactly the bug
 * this tool would otherwise ship, and the guard cannot see it.
 */
function planValueSites(
  references: readonly ClassifiedReference[],
  declaration: ts.NamedDeclaration,
  name: string,
  reExportedIn: string[],
): Planned[] {
  const planned: Planned[] = [];
  for (const reference of references) {
    const node = reference.node;
    const parent = node.parent as ts.Node | undefined;
    if (isTypeQueryReference(node)) continue;

    switch (reference.kind) {
      case 'import-binding':
      case 'type-position':
        continue;

      case 'export-specifier':
        reExportedIn.push(reference.file);
        continue;

      case 'declaration': {
        // `{ flag: expr }` contextually typed by the declaring type is a
        // write of the property; the classifier reports the key as a
        // declaration because syntactically that is what it is.
        if (parent && ts.isPropertyAssignment(parent) && parent.name === node) {
          planned.push({ kind: 'write', target: parent.initializer, phase: 0 });
          continue;
        }
        if (parent && ts.isShorthandPropertyAssignment(parent)) {
          throw new Error(
            `"${name}" is written as a shorthand property at ${describeReference(reference)}; the ` +
              'negation would have to expand it to a longhand `name: !value`, which also changes ' +
              'what a rename means there',
          );
        }
        if (parent === declaration) {
          const initializer = initializerOf(declaration);
          if (initializer) planned.push({ kind: 'initializer', target: initializer, phase: 0 });
          continue;
        }
        throw new Error(
          `"${name}" has a second declaration at ${describeReference(reference)}; inverting one ` +
            'declaration of a merged symbol would leave the other saying the opposite',
        );
      }

      case 'read': {
        if (parent && ts.isShorthandPropertyAssignment(parent)) {
          throw new Error(
            `"${name}" is read as a shorthand property at ${describeReference(reference)}; the ` +
              'negation would have to expand it to a longhand `name: !value`',
          );
        }
        planned.push({ kind: 'read', target: valueExpressionOf(node), phase: 1 });
        continue;
      }

      case 'write': {
        const assignment = assignmentOf(valueExpressionOf(node));
        if (!assignment) {
          throw new Error(
            `"${name}" is written at ${describeReference(reference)} in a form this tool cannot ` +
              'read as `target = value`',
          );
        }
        if (assignmentValueIsUsed(assignment)) {
          throw new Error(
            `The assignment to "${name}" at ${describeReference(reference)} is itself used as a ` +
              'value, so negating what it stores would invert the surrounding expression too',
          );
        }
        planned.push({ kind: 'write', target: assignment.right, phase: 0 });
        continue;
      }

      case 'compound-write':
        throw new Error(
          `"${name}" is compound-assigned at ${describeReference(reference)}. \`x ||= e\` means ` +
            '`if (!x) x = e`, and once `x` means its own opposite no compound operator expresses ' +
            'that — the statement has to be rewritten by hand first',
        );

      case 'destructure-read':
      case 'destructure-write':
        throw new Error(
          `"${name}" is destructured at ${describeReference(reference)}, which binds its value to ` +
            'a second name this tool does not follow; that binding would silently keep the old sense',
        );

      default:
        throw new Error(
          `"${name}" is used at ${describeReference(reference)} as ${reference.kind}, where its ` +
            'truthiness is consumed by something this tool cannot rewrite',
        );
    }
  }
  return planned;
}

/** The declaration whose name addresses the callable a parameter belongs to. */
function ownerOfParameter(parameter: ts.ParameterDeclaration): {
  callable: CallableDeclaration;
  named: ts.NamedDeclaration;
} {
  const owner = parameter.parent;
  const callable = callableOf(owner);
  const parameterName = nameOf(parameter);
  if (!callable) {
    throw new Error(
      `The owner of parameter "${parameterName}" is a ${ts.SyntaxKind[owner.kind]}, which has no ` +
        'body and no call sites this tool can rewrite',
    );
  }
  if (ts.isFunctionDeclaration(callable) || ts.isMethodDeclaration(callable)) {
    if (!callable.name) {
      throw new Error(`Parameter "${parameterName}" belongs to an anonymous function`);
    }
    return { callable, named: callable };
  }
  const holder = callable.parent;
  if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
    return { callable, named: holder };
  }
  throw new Error(
    `Parameter "${parameterName}" belongs to an unnamed function expression, so its call sites ` +
      'cannot be found',
  );
}

export const invertBoolean: Tool<InvertBooleanInput, InvertBooleanOutput, TsProjectSession> = {
  name: 'ts/refactors/invert-boolean',
  description:
    "Inverts the sense of a boolean function, variable, property, or parameter — ReSharper's " +
    'Invert Boolean. A function has every `return` negated and every call negated; a variable, ' +
    'property, or parameter has its initializer, every assignment, and every read negated, and ' +
    'for a parameter the argument at every call site as well. newName also renames the ' +
    'declaration project-wide, through ts/refactors/rename, in the same edit. Sound only when ' +
    'the checker says the type is exactly `boolean`: TypeScript coerces anything to a truth ' +
    'value, so for `boolean | undefined` — an ordinary optional flag — `!x` maps both `false` ' +
    'and `undefined` to `true`, which is a silent change of meaning rather than an inversion. ' +
    'Anything wider is refused, as are a member another type in the hierarchy also declares, a ' +
    'compound assignment (`x ||= e` has no negated form), a destructured or shorthand-property ' +
    'reference, an assignment whose own value is consumed, and a function handed out as a value. ' +
    'Negation is structural: `!isVisible` collapses to `isVisible`, `a === b` becomes `a !== b`, ' +
    '`true` becomes `false`, and brackets come from the compiler. Relational operators are not ' +
    'flipped, because `!(a < b)` is not `a >= b` when either side is NaN. Note that a typecheck ' +
    'cannot see this refactoring go wrong — every site is boolean before and after — so the ' +
    'refusals, not newDiagnostics, are what make it safe. Dry-run by default.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      newName: {
        type: 'string',
        description: 'Also rename the declaration, e.g. isVisible -> isHidden',
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      sites: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            line: { type: 'integer' },
            character: { type: 'integer' },
            kind: {
              type: 'string',
              enum: ['return', 'call', 'read', 'write', 'initializer', 'argument'],
            },
          },
          required: ['file', 'line', 'character', 'kind'],
        },
      },
    },
    ['sites'],
  ),

  async run(session, input) {
    const target = resolveTarget(session, input);
    const declaration = declarationAt(target);
    const name = nameOf(declaration);
    if (declaration.getSourceFile().isDeclarationFile) {
      throw new Error(`"${name}" is declared in a .d.ts file, which this tool does not rewrite`);
    }
    if (input.newName === name) {
      throw new Error(`"${name}" is already called that; drop newName to invert without renaming`);
    }

    const checker = session.checker();
    const warnings: string[] = [];
    const planned: Planned[] = [];
    /** Files whose `export { … }` line re-exports the target. */
    const reExportedIn: string[] = [];

    const callable = ts.isParameter(declaration) ? undefined : callableOf(declaration);
    if (callable) {
      // ---- a predicate: negate its returns and every call -------------
      const signature = checker.getSignatureFromDeclaration(callable);
      const returns = signature ? checker.getReturnTypeOfSignature(signature) : undefined;
      if (!returns || !isExactlyBoolean(returns)) {
        throw new Error(
          `"${name}" returns \`${returns ? checker.typeToString(returns) : 'nothing resolvable'}\`, ` +
            'not exactly `boolean`. Negating a read of anything wider is a truthiness test, not ' +
            'an inversion — for `boolean | undefined`, `!x` reports true for both `false` and ' +
            '`undefined`.',
        );
      }
      if (ts.isMethodDeclaration(callable)) assertSoleDeclaration(session, callable, name);

      const declarations = (
        declaration.name ? (checker.getSymbolAtLocation(declaration.name)?.declarations ?? []) : []
      ).filter((node) => callableOf(node) !== undefined);
      if (declarations.length > 1) {
        throw new Error(
          `"${name}" is an overload set (${String(declarations.length)} declarations), so a call ` +
            'may resolve to a body this edit never sees',
        );
      }

      for (const expression of returnExpressions(callable, name)) {
        planned.push({ kind: 'return', target: expression, phase: 0 });
      }

      const survey = surveyCallSites(session, target.file, target.offset, name);
      assertOnlyCalls(
        name,
        { ...survey, escapes: survey.escapes.filter((r) => !isTypeQueryReference(r.node)) },
        `inverting "${name}"`,
      );
      for (const reference of survey.calls) {
        const call = callLikeOf(reference.node);
        if (!call) throw new Error(`Cannot find the call at ${describeReference(reference)}`);
        planned.push({ kind: 'call', target: call, phase: 1 });
      }
      // The survey drops declaring references, and a barrel line is one.
      for (const reference of classifyReferences(session, target.file, target.offset)) {
        if (reference.kind === 'export-specifier') reExportedIn.push(reference.file);
      }
    } else {
      // ---- a value: negate its writes and every read ------------------
      if (
        !ts.isVariableDeclaration(declaration) &&
        !ts.isPropertyDeclaration(declaration) &&
        !ts.isPropertySignature(declaration) &&
        !ts.isParameter(declaration)
      ) {
        throw new Error(
          `"${name}" is a ${ts.SyntaxKind[declaration.kind]}; this tool inverts a function, a ` +
            'variable, a property, or a parameter',
        );
      }
      const symbol = declaration.name ? checker.getSymbolAtLocation(declaration.name) : undefined;
      if (!symbol) throw new Error(`"${name}" does not resolve to a symbol`);
      // Read at the declaration, where control flow has narrowed nothing.
      // This is the symbol's type rather than its annotation's, which is
      // what makes an optional property fail: `off?: boolean` is
      // `boolean | undefined` however the annotation reads.
      const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
      if (!isExactlyBoolean(type)) {
        throw new Error(
          `"${name}" has type \`${checker.typeToString(type)}\`, not exactly \`boolean\`. ` +
            'TypeScript coerces anything to a truth value, so `!x` here is a truthiness test ' +
            'rather than an inversion: for `boolean | undefined` it reports true for both ' +
            '`false` and `undefined`, collapsing three cases onto two with no diagnostic.',
        );
      }
      if (ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration)) {
        assertSoleDeclaration(session, declaration, name);
        warnings.push(
          `"${name}" is a property, and TypeScript is structurally typed: a value that satisfies ` +
            'its container without naming this declaration is not in the reference set and keeps ' +
            'the old sense.',
        );
      }

      if (ts.isParameter(declaration)) {
        if (!ts.isIdentifier(declaration.name)) {
          throw new Error(`"${name}" is a destructured parameter, with no single name to flip`);
        }
        if (declaration.dotDotDotToken) {
          throw new Error(`"${name}" is a rest parameter, which collects a list rather than a flag`);
        }
        // A parameter is half of a signature: flipping it flips what every
        // argument has to say, so the owner's call sites are part of this
        // edit and an owner that is not only called is a refusal.
        const owner = ownerOfParameter(declaration);
        const ownerName = nameOf(owner.named);
        if (ts.isMethodDeclaration(owner.callable)) {
          assertSoleDeclaration(session, owner.callable, ownerName);
        }
        const ownerSymbol = owner.named.name
          ? checker.getSymbolAtLocation(owner.named.name)
          : undefined;
        const ownerDeclarations = (ownerSymbol?.declarations ?? []).filter(
          (node) => callableOf(node) !== undefined,
        );
        if (ownerDeclarations.length > 1) {
          throw new Error(
            `"${ownerName}" is an overload set, so which argument feeds "${name}" is not settled ` +
              'by this declaration alone',
          );
        }

        const ownerFile = owner.named.getSourceFile();
        const ownerOffset = (owner.named.name as ts.Node).getStart(ownerFile);
        const survey = surveyCallSites(session, ownerFile.fileName, ownerOffset, ownerName);
        assertOnlyCalls(ownerName, survey, `inverting its parameter "${name}"`);
        for (const reference of survey.calls) {
          const { call, signature } = resolveCall(checker, reference, owner.callable, ownerName);
          const index = argumentIndexOf(signature, declaration);
          const argument = index === -1 ? undefined : call.arguments?.[index];
          // An omitted argument takes the default, which is negated at the
          // declaration; there is nothing at the call site to flip.
          if (argument) planned.push({ kind: 'argument', target: argument, phase: 0 });
        }
      }

      const references = classifyReferences(session, target.file, target.offset);
      planned.push(...planValueSites(references, declaration, name, reExportedIn));
    }

    if (planned.length === 0) {
      throw new Error(
        `Nothing references "${name}" and it has no initializer, so there is no sense to invert`,
      );
    }

    // Value sites first — see Planned.phase — then in source order, so the
    // same input always produces the same edit.
    const ordered = [...planned].sort(
      (a, b) =>
        a.phase - b.phase ||
        a.target.getSourceFile().fileName.localeCompare(b.target.getSourceFile().fileName) ||
        a.target.getStart() - b.target.getStart(),
    );

    const negator: Negator = { checker, claimed: new Set<string>() };
    const changes: Record<string, TextEdit[]> = {};
    const sites: InvertSite[] = [];
    for (const entry of ordered) {
      const sourceFile = entry.target.getSourceFile();
      const file = path.resolve(sourceFile.fileName);
      changes[file] = [...(changes[file] ?? []), ...negationEdits(negator, entry.target)];
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        entry.target.getStart(sourceFile),
      );
      sites.push({ file, line, character, kind: entry.kind });
    }
    sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character);

    let edit: WorkspaceEdit = { changes: mergeSameRange(changes) };
    if (input.newName !== undefined) {
      // Renaming is not reimplemented here. The language server rewrites
      // identifier spans and nothing else; every edit above is a bracket,
      // a `!`, an operator, or a keyword, so the two sets cannot overlap
      // and travel as one WorkspaceEdit under one guard.
      const renamed = await rename.run(session, {
        newName: input.newName,
        file: target.file,
        line: target.position.line,
        character: target.position.character,
      });
      edit = mergeWorkspaceEdits(edit, renamed.edit);
    }

    for (const file of [...new Set(reExportedIn)]) {
      warnings.push(
        `${path.basename(file)} re-exports "${name}", so consumers reached through that barrel see ` +
          'the inverted sense with nothing in the re-export to say so' +
          (input.newName === undefined
            ? '.'
            : `. The rename leaves that line as \`${input.newName} as ${name}\`, which keeps the ` +
              'old external name on the new, opposite meaning — rename the re-export too, or ' +
              'consumers read exactly backwards.'),
      );
    }
    warnings.push(
      'A typecheck cannot see this refactoring go wrong: every site it rewrites is boolean before ' +
        'and after, so newDiagnostics proves the edit still compiles and nothing about it still ' +
        'meaning the same thing. What stands in for the guard here is the exact `boolean` test and ' +
        'a refusal for every reference that could not be rewritten.',
    );
    if (isExported(declaration)) {
      warnings.push(
        `"${name}" is exported, so its sense is part of this module's public surface. The guard ` +
          'typechecks this project only; a consumer outside it sees the inverted value and no error.',
      );
    }

    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output = { edit, filesChanged, newDiagnostics, warnings, sites };
    if (input.apply !== true || newDiagnostics.length > 0) {
      return { applied: false, ...output };
    }
    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return { applied: true, ...output };
  },
};
