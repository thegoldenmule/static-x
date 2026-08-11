import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { Position, TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences, isUse, isWrite } from '../references.js';
import { describeReferences, locationOf } from '../signatures.js';
import {
  captureConflicts,
  mayHaveEffects,
  needsParentheses,
  rootIdentifiers,
  substituteExpression,
} from '../substitution.js';

/**
 * Replaces every read of a `const` with its initializer and deletes the
 * declaration — ReSharper's Inline Variable.
 *
 * TypeScript ships this one outright, as `refactor.inline.variable`, and
 * it is the reason `substitution.ts` exists. Measured against 5.9.3 on a
 * scratch project, all four of these compile clean and all four are
 * wrong:
 *
 * - `const d = a - b; return c - d` becomes `return c - a-b`. It ranks
 *   precedence without asking which operand the result lands in.
 * - `const v = bump(); return v + v + v` becomes `bump() + bump() +
 *   bump()`. One call becomes three.
 * - `const o = {k: 1}; return o === o` becomes `{k: 1} === {k: 1}`,
 *   which was `true` and is now `false`. Nothing is called, so a purity
 *   check alone would not have caught it — allocation is its own hazard.
 * - `const s = SCALE * 2` read inside a block declaring its own
 *   `SCALE = 100` becomes `SCALE*2 + SCALE`, computing 300 where it
 *   computed 106.
 *
 * `diagnosticsIntroducedBy` reports nothing for any of them, which is
 * why each is refused *before* the edit is built rather than caught
 * after it.
 *
 * Unlike the engine's version — which returned no edits at all, and no
 * error, for an exported `const` read from another file — this one is
 * project-wide. An exported binding is inlined when its initializer is
 * portable, and the imports and re-exports that reached it go with it.
 */

export interface InlineVariableInput {
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  apply?: boolean;
}

export interface ReadSite extends Position {
  file: string;
}

export interface InlineVariableOutput extends RefactorOutput {
  /** Every read the edit replaces. */
  readSites: ReadSite[];
  /** The initializer that was substituted, as written. */
  value: string;
}

/** Reference kinds that read the value and can take an expression. */
const READING: ReadonlySet<string> = new Set([
  'read',
  'destructure-read',
  'direct-call',
  'new',
  'spread-call',
]);

/** Expressions that produce a new object every time they are evaluated. */
function allocates(expression: ts.Node): boolean {
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
function readsProperty(checker: ts.TypeChecker, expression: ts.Node): boolean {
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
function isEffectfulNode(node: ts.Node): boolean {
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
function pathToDeclaration(
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
function repeatsOrSkips(between: readonly ts.Node[]): boolean {
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
function effectsBetween(common: ts.Node, from: number, to: number): boolean {
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
function thisScope(node: ts.Node): ts.Node | undefined {
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
function usesReceiver(expression: ts.Node): boolean {
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
function reassignedNames(session: TsProjectSession, initializer: ts.Expression): string[] {
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
 * Places where the declaring module is reached as a whole object rather
 * than by name — `registry[key]`, `Object.keys(registry)`, `{...registry}`.
 *
 * A reference search names none of these, so a constant deleted out from
 * under one becomes `undefined` at runtime with no diagnostic anywhere.
 * Uses in type position are excluded: `keyof typeof registry` reads the
 * module's shape, which survives the edit as a type either way.
 */
function opaqueNamespaceUses(session: TsProjectSession, declarationFile: ts.SourceFile): string[] {
  const checker = session.checker();
  const opaque: string[] = [];
  for (const sourceFile of session.compilationFiles()) {
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const named = statement.importClause?.namedBindings;
      if (!named || !ts.isNamespaceImport(named)) continue;
      const moduleSymbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
      if ((moduleSymbol?.valueDeclaration ?? moduleSymbol?.declarations?.[0]) !== declarationFile) {
        continue;
      }

      const alias = checker.getSymbolAtLocation(named.name);
      const visit = (node: ts.Node): void => {
        if (
          ts.isIdentifier(node) &&
          node !== named.name &&
          checker.getSymbolAtLocation(node) === alias &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) &&
          !isInTypePosition(node)
        ) {
          opaque.push(locationOf(sourceFile, node.getStart(sourceFile)));
        }
        node.forEachChild(visit);
      };
      sourceFile.forEachChild(visit);
    }
  }
  return opaque;
}

function isInTypePosition(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isTypeNode(current) || ts.isTypeQueryNode(current)) return true;
    if (ts.isStatement(current)) return false;
  }
  return false;
}

/**
 * Remove the binding a file used to reach the inlined constant.
 *
 * Once every read is gone the import names something that no longer
 * exists — TS2305, a hard error rather than untidiness — and a re-export
 * of it is the same error one module further out.
 */
function removeBinding(reference: ts.Node, sourceFile: ts.SourceFile): TextEdit | undefined {
  const specifier = reference.parent;
  if (!specifier) return undefined;
  const at = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset);
  const wholeLine = (statement: ts.Node): TextEdit => {
    const text = sourceFile.getFullText();
    let end = statement.getEnd();
    while (end < text.length && text[end] !== '\n') end++;
    if (end < text.length) end++;
    return { range: { start: at(statement.getStart(sourceFile)), end: at(end) }, newText: '' };
  };

  if (ts.isExportSpecifier(specifier)) {
    const named = specifier.parent;
    if (named.elements.length > 1) {
      return { range: rangeOfElement(specifier, named.elements, sourceFile, at), newText: '' };
    }
    return wholeLine(named.parent);
  }

  if (!ts.isImportSpecifier(specifier)) return undefined;
  const named = specifier.parent;
  const clause = named.parent;
  if (named.elements.length > 1) {
    return { range: rangeOfElement(specifier, named.elements, sourceFile, at), newText: '' };
  }
  if (clause.name) {
    // `import Default, { only }` — the default binding stays.
    return { range: { start: at(clause.name.getEnd()), end: at(named.getEnd()) }, newText: '' };
  }
  return wholeLine(clause.parent);
}

/** The span that takes one element of a list along with its comma. */
function rangeOfElement(
  element: ts.Node,
  elements: ts.NodeArray<ts.Node>,
  sourceFile: ts.SourceFile,
  at: (offset: number) => Position,
): { start: Position; end: Position } {
  const index = elements.indexOf(element);
  const start = index === 0 ? element.getStart(sourceFile) : elements[index - 1]!.getEnd();
  const end = index === 0 ? elements[1]!.getStart(sourceFile) : element.getEnd();
  return { start: at(start), end: at(end) };
}

/** Removes the declarator — and its statement, when it was the only one. */
function removeDeclarator(
  declaration: ts.VariableDeclaration,
  list: ts.VariableDeclarationList,
  statement: ts.VariableStatement,
): TextEdit {
  const sourceFile = declaration.getSourceFile();
  const at = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset);

  if (list.declarations.length > 1) {
    return { range: rangeOfElement(declaration, list.declarations, sourceFile, at), newText: '' };
  }

  const text = sourceFile.getFullText();
  // getStart(sourceFile, true) includes the JSDoc, which described the
  // constant and describes nothing once it is gone.
  let start = statement.getStart(sourceFile, true);
  while (start > 0 && text[start - 1] !== '\n') start--;
  let end = statement.getEnd();
  while (end < text.length && text[end] !== '\n') end++;
  if (end < text.length) end++;
  // A blank line left behind reads as a hole where the constant was.
  if (text.slice(end, end + 1) === '\n') end++;
  return { range: { start: at(start), end: at(end) }, newText: '' };
}

/** Whether the declaration is part of this module's public surface. */
function isExported(statement: ts.VariableStatement): boolean {
  return (statement.modifiers ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

/**
 * The node a read occupies: the identifier, or the whole member access
 * when the constant is reached through a namespace import. Replacing
 * only the identifier in `units.STEP` would leave `units.5`.
 */
function readExpression(node: ts.Node): ts.Node {
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

export const inlineVariable: Tool<InlineVariableInput, InlineVariableOutput, TsProjectSession> = {
  name: 'ts/refactors/inline-variable',
  description:
    "Replaces every read of a `const` with its initializer and deletes it — ReSharper's Inline " +
    "Variable. Targets the declaration by name (symbol) or exact position. Unlike TypeScript's " +
    'own inline-variable, which silently produces no edits across files, this follows the ' +
    'constant into every module that imports it and removes the imports and re-exports left ' +
    'behind. Parentheses come from the compiler and are decided by the operand position the ' +
    'read sat in, so `total - OFFSET` with an initializer of `10 - 4` becomes ' +
    '`total - (10 - 4)` rather than the wrong `total - 10 - 4`. Refuses a `let`, `var` or ' +
    '`using`; a destructured or uninitialized binding; a read in a type position, where an ' +
    'expression cannot go; an initializer whose names resolve differently, or not at all, at a ' +
    'read; an initializer reading a variable that is assigned somewhere, whose value at the ' +
    'read would differ; and an initializer that calls, allocates, or reads a property unless ' +
    'there is exactly one read, reached without a branch or a loop and with nothing observable ' +
    'evaluated in between. An exported constant that nothing in the project reads is refused, ' +
    'and so is one whose module is used as a whole object somewhere, because in both cases the ' +
    'readers are outside what can be checked. Dry-run by default.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      readSites: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            line: { type: 'integer' },
            character: { type: 'integer' },
          },
        },
      },
      value: { type: 'string' },
    },
    ['readSites', 'value'],
  ),

  async run(session, input) {
    const target = resolveTarget(session, input);
    const declaration = declarationAt(target);
    if (!ts.isVariableDeclaration(declaration)) {
      throw new Error(
        `${target.file}:${target.position.line + 1} is not a variable declaration — ` +
          'inline-function covers functions and methods',
      );
    }
    const declarationFile = declaration.getSourceFile();
    if (declarationFile.isDeclarationFile) {
      throw new Error('A declaration file states a type and holds no initializer to inline');
    }
    // A `catch (e)` binding is a VariableDeclaration too, bound by the
    // runtime rather than by anything there is to substitute.
    const list = declaration.parent;
    if (!ts.isVariableDeclarationList(list)) {
      throw new Error('The binding is a `catch` clause parameter, which has no initializer');
    }
    const statement = list.parent;
    if (!ts.isVariableStatement(statement)) {
      throw new Error(
        'The declaration is a loop initializer, whose binding exists only inside the loop',
      );
    }
    if (!ts.isIdentifier(declaration.name)) {
      throw new Error(
        'The binding is destructured, so it names a property of something rather than one ' +
          'expression there is an initializer for',
      );
    }
    const name = declaration.name.text;

    const flags = ts.getCombinedNodeFlags(declaration);
    // AwaitUsing is Const|Using, so testing Const alone accepts it.
    if ((flags & ts.NodeFlags.Using) !== 0) {
      throw new Error(
        `"${name}" is a \`using\` declaration, whose value is disposed when its scope ends — ` +
          'inlining it would move or duplicate that disposal',
      );
    }
    if ((flags & ts.NodeFlags.Const) === 0) {
      const keyword = (flags & ts.NodeFlags.Let) !== 0 ? 'let' : 'var';
      throw new Error(
        `"${name}" is declared with \`${keyword}\`, so its reads are not all its initializer. ` +
          'Only a `const` holds one value for its whole life.',
      );
    }

    const initializer = declaration.initializer;
    if (!initializer) {
      throw new Error(`"${name}" has no initializer, so there is nothing to substitute`);
    }

    const references = classifyReferences(session, target.file, target.offset);
    const writes = references.filter(isWrite);
    if (writes.length > 0) {
      throw new Error(
        `"${name}" is written after it is initialized, so its reads are not all its ` +
          `initializer:\n  ${describeReferences(writes)}`,
      );
    }
    const reads = references.filter((reference) => READING.has(reference.kind));
    const bindings = references.filter(
      (reference) => reference.kind === 'import-binding' || reference.kind === 'export-specifier',
    );
    const unusable = references
      .filter(isUse)
      .filter((reference) => !READING.has(reference.kind));
    if (unusable.length > 0) {
      throw new Error(
        `"${name}" is used where an expression cannot go — a type query, or a position that ` +
          `names the binding rather than reading it:\n  ${describeReferences(unusable)}`,
      );
    }

    const exported = isExported(statement);
    if (reads.length === 0) {
      if (exported) {
        throw new Error(
          `"${name}" is exported and nothing in this project reads it, so its readers — if it ` +
            'has any — are outside the compilation, where neither the substitution nor the ' +
            'guard can reach them',
        );
      }
      throw new Error(`Nothing reads "${name}", so there is nothing to inline into. Delete it.`);
    }
    if (exported) {
      const opaque = opaqueNamespaceUses(session, declarationFile);
      if (opaque.length > 0) {
        throw new Error(
          `${path.relative(session.rootPath, declarationFile.fileName)} is imported as a whole ` +
            `namespace object and used as one at:\n  ${opaque.join('\n  ')}\nA member read ` +
            `through that object is not a reference to "${name}" anyone can find, so deleting ` +
            'it would leave `undefined` at runtime and nothing at compile time.',
        );
      }
    }

    const checker = session.checker();
    const volatile =
      mayHaveEffects(initializer) || allocates(initializer) || readsProperty(checker, initializer);
    if (volatile) {
      const why = mayHaveEffects(initializer)
        ? 'could do something observable'
        : allocates(initializer)
          ? 'builds a new object every time it is evaluated'
          : 'reads a property, which may hold something else by then';
      if (reads.length > 1) {
        throw new Error(
          `The initializer of "${name}" ${why}, and it is read ${String(reads.length)} times — ` +
            `inlining would evaluate it once per read:\n  ${describeReferences(reads)}`,
        );
      }
      const read = reads[0]!;
      if (path.resolve(read.file) !== path.resolve(declarationFile.fileName)) {
        throw new Error(
          `The initializer of "${name}" ${why}, and its only read is in another module, where ` +
            'when it runs relative to this one is a fact about module loading order',
        );
      }
      const { between, common } = pathToDeclaration(read.node, declaration);
      if (!common || repeatsOrSkips(between)) {
        throw new Error(
          `The initializer of "${name}" ${why}, and the read at ` +
            `${locationOf(declarationFile, read.offset)} sits behind a branch, a loop or a ` +
            'nested function — inlining would change how many times it happens',
        );
      }
      if (effectsBetween(common, declaration.getEnd(), read.node.getStart())) {
        throw new Error(
          `The initializer of "${name}" ${why}, and something else observable is evaluated ` +
            `before the read at ${locationOf(declarationFile, read.offset)} — inlining would ` +
            'reorder the two',
        );
      }
    }

    if (usesReceiver(initializer)) {
      const scope = thisScope(declaration);
      const elsewhere = reads.filter((read) => thisScope(read.node) !== scope);
      if (elsewhere.length > 0) {
        throw new Error(
          `The initializer of "${name}" reads \`this\`, which means something else at:\n  ` +
            describeReferences(elsewhere),
        );
      }
    }

    const unstable = reassignedNames(session, initializer);
    if (unstable.length > 0) {
      throw new Error(
        `The initializer of "${name}" reads ${unstable.map((n) => `"${n}"`).join(', ')}, which ` +
          `${unstable.length === 1 ? 'is' : 'are'} assigned elsewhere — a read would get ` +
          'whatever it holds then, not what it held here. Both compile.',
      );
    }

    const warnings: string[] = [];
    if (declaration.type) {
      const declared = checker.getTypeAtLocation(declaration.name);
      const actual = checker.getTypeAtLocation(initializer);
      if (declared !== actual) {
        warnings.push(
          `"${name}" is annotated \`${declaration.type.getText(declarationFile)}\` and its ` +
            `initializer's own type is \`${checker.typeToString(actual)}\`. A read was typed by ` +
            'the annotation and the expression replacing it is not, which can change an ' +
            'overload choice or a contextual type without changing whether it compiles.',
        );
      }
    }
    if (exported) {
      warnings.push(
        `${path.relative(session.rootPath, declarationFile.fileName)} exported "${name}"; ` +
          "inlining it removes the name from that module's public surface, which consumers " +
          'outside this project would notice.',
      );
    }

    // One substitution serves every read: with no parameters to bind,
    // what changes between sites is only whether it needs wrapping.
    const substituted = substituteExpression(initializer, declarationFile, new Map());

    const changes: Record<string, TextEdit[]> = {};
    const readSites: ReadSite[] = [];
    for (const read of reads) {
      const sourceFile = read.node.getSourceFile();

      // Every name the initializer depends on has to still mean the same
      // thing here. One that resolves to a different symbol compiles and
      // silently computes something else — the failure the guard is
      // blind to, and the reason this runs before the edit is built.
      const conflicts = captureConflicts(checker, initializer, read.node, new Set());
      if (conflicts.length > 0) {
        const missing = conflicts.filter((conflict) => conflict.reason === 'missing');
        const shadowed = conflicts.filter((conflict) => conflict.reason === 'different');
        throw new Error(
          `The initializer of "${name}" cannot be evaluated at ${locationOf(sourceFile, read.offset)}: ` +
            [
              missing.length > 0
                ? `${missing.map((c) => `"${c.name}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in scope there`
                : '',
              shadowed.length > 0
                ? `${shadowed.map((c) => `"${c.name}"`).join(', ')} ${shadowed.length === 1 ? 'means' : 'mean'} something different there`
                : '',
            ]
              .filter(Boolean)
              .join('; '),
        );
      }

      const site = readExpression(read.node);
      const inlined = needsParentheses(substituted.expression, site)
        ? `(${substituted.text})`
        : substituted.text;
      // `{ x }` is the one read whose replacement is not the expression
      // itself: `{ 10 - 4 }` does not parse, so it becomes long form.
      const shorthand = site.parent;
      const replaced = shorthand && ts.isShorthandPropertyAssignment(shorthand) ? shorthand : site;
      const newText = replaced === site ? inlined : `${name}: ${inlined}`;

      const file = path.resolve(sourceFile.fileName);
      changes[file] = [
        ...(changes[file] ?? []),
        {
          range: {
            start: sourceFile.getLineAndCharacterOfPosition(replaced.getStart(sourceFile)),
            end: sourceFile.getLineAndCharacterOfPosition(replaced.getEnd()),
          },
          newText,
        },
      ];
      readSites.push({ file, line: read.line, character: read.character });
    }

    for (const binding of bindings) {
      const sourceFile = binding.node.getSourceFile();
      const removal = removeBinding(binding.node, sourceFile);
      if (!removal) continue;
      const file = path.resolve(sourceFile.fileName);
      changes[file] = [...(changes[file] ?? []), removal];
      if (binding.kind === 'export-specifier') {
        warnings.push(
          `${path.relative(session.rootPath, file)} re-exported "${name}"; that line goes with ` +
            'the declaration, so the name leaves that module too.',
        );
      }
    }

    const declarationPath = path.resolve(declarationFile.fileName);
    changes[declarationPath] = [
      ...(changes[declarationPath] ?? []),
      removeDeclarator(declaration, list, statement),
    ];

    const edit: WorkspaceEdit = { changes };
    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output = {
      edit,
      filesChanged,
      newDiagnostics,
      warnings,
      readSites,
      value: initializer.getText(declarationFile),
    };

    if (input.apply !== true || newDiagnostics.length > 0) {
      return { applied: false, ...output };
    }
    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return { applied: true, ...output };
  },
};
