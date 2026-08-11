import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { memberHierarchy } from '../../ast/hierarchy.js';
import { tokenKey } from '../../ast/structural.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { locateSelection, SELECTION_PROPERTIES } from '../selection.js';
import {
  assertOnlyCalls,
  callableOf,
  locationOf,
  resolveCall,
  surveyCallSites,
  type CallableDeclaration,
} from '../signatures.js';
import { captureConflicts, mayHaveEffects, rootIdentifiers, unalias } from '../substitution.js';

/**
 * Introduce Parameter: an expression inside a function becomes a new
 * parameter, and the expression itself is passed at every call site.
 *
 * The exact inverse of `inline-parameter`, and it is a *tool* for the
 * same reason: the edit lands in files the caller never opened. It also
 * reaches further than an argument list, because TypeScript's typing is
 * structural — a function assigned to a declared function type has its
 * arity checked there by assignability, where a wrong arity compiles and
 * misbehaves. `assertOnlyCalls` is what refuses that, and it refuses it
 * even in the `defaultValue` form, where an *optional* parameter is
 * assignment-compatible: `lines.map(tag)` starts feeding map's index
 * argument into the new parameter, silently, with `tsc` green.
 *
 * Every structurally identical occurrence in the body is replaced, not
 * just the one selected — a parameter that stands for one of two
 * identical sub-expressions is not what anybody means, and leaving the
 * other behind is the kind of half-refactor that reads as done.
 */

export interface IntroduceParameterInput {
  /** File the expression lives in. */
  file: string;
  /** The exact expression to turn into a parameter. */
  select: string;
  /** Name of the enclosing function, when the expression occurs in more than one. */
  within?: string;
  /** Name for the new parameter. */
  name: string;
  /**
   * Where the parameter goes among the *value* parameters — a `this`
   * parameter is not one. Default `'append'`.
   */
  position?: 'append' | number;
  /**
   * Expression to default the parameter to. Given, the parameter is
   * optional and no call site is touched, which is what makes this
   * non-breaking for an exported function.
   */
  defaultValue?: string;
  /** Write the edit to disk. Default false: return the edit only. */
  apply?: boolean;
}

export interface CallSitePosition {
  file: string;
  line: number;
  character: number;
}

export interface IntroduceParameterOutput extends RefactorOutput {
  /** Every call the edit passes the expression at, or would have to. */
  callSites: CallSitePosition[];
  /** Occurrences of the expression the parameter replaced in the body. */
  occurrences: number;
}

const IDENTIFIER = /^[$_\p{ID_Start}][$\p{ID_Continue}]*$/u;

function parseDiagnosticsOf(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  return (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
}

/** The single expression `source` is, parsed on its own, or undefined. */
function parseExpression(source: string): { node: ts.Expression; file: ts.SourceFile } | undefined {
  const trimmed = source.trim();
  if (trimmed === '') return undefined;
  // Wrapped in parentheses and on its own lines, so `{ a: 1 }` reads as
  // an object literal rather than a block and a trailing `//` comment
  // cannot swallow the closer.
  const file = ts.createSourceFile(
    '__select.ts',
    `(\n${trimmed}\n);`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (parseDiagnosticsOf(file).length > 0 || file.statements.length !== 1) return undefined;
  const statement = file.statements[0]!;
  if (!ts.isExpressionStatement(statement) || !ts.isParenthesizedExpression(statement.expression)) {
    return undefined;
  }
  return { node: statement.expression.expression, file };
}

/** An identifier that names something rather than referring to it. */
function isNamePosition(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isMetaProperty(parent) ||
    ts.isBreakOrContinueStatement(parent)
  ) {
    return true;
  }
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  if (ts.isJsxAttribute(parent) && parent.name === node) return true;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isBindingElement(parent) ||
      ts.isEnumMember(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  return false;
}

/**
 * A `typeof x` query holds an identifier that `ts.isExpression` accepts,
 * so without this an occurrence inside a type would be "replaced" and
 * the parameter would end up naming its own type.
 */
function insideType(node: ts.Node): boolean {
  for (let current = node.parent as ts.Node | undefined; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isBlock(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

/** Whether the occurrence is assigned to rather than merely read. */
function isWriteTarget(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) return false;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return true;
  }
  if (
    (ts.isPostfixUnaryExpression(parent) || ts.isPrefixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  if (ts.isDeleteExpression(parent)) return true;
  if (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) return parent.initializer === node;
  return false;
}

/** The name a callable is declared under, however it is written. */
function nameOfCallable(callable: CallableDeclaration): ts.Identifier | undefined {
  if (
    (ts.isFunctionDeclaration(callable) || ts.isMethodDeclaration(callable)) &&
    callable.name &&
    ts.isIdentifier(callable.name)
  ) {
    return callable.name;
  }
  const parent = callable.parent as ts.Node | undefined;
  if (
    parent &&
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertyAssignment(parent)) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name;
  }
  if (ts.isFunctionExpression(callable) && callable.name) return callable.name;
  return undefined;
}

/**
 * The innermost named function whose *body* holds this node.
 *
 * Walking outward past an anonymous callback is deliberate: an
 * expression inside `values.map((v) => v * 10)` has no signature of its
 * own to change, but the enclosing function's new parameter is in scope
 * inside the callback by closure, so putting it there is both possible
 * and what the caller meant.
 */
function targetCallable(node: ts.Node): { callable: CallableDeclaration; name: ts.Identifier } | undefined {
  for (let current = node.parent as ts.Node | undefined; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const callable = callableOf(current);
    if (!callable || !callable.body) continue;
    if (node.getStart() < callable.body.getStart() || node.getEnd() > callable.body.getEnd()) {
      continue;
    }
    const name = nameOfCallable(callable);
    if (name) return { callable, name };
  }
  return undefined;
}

function indentationAt(sourceFile: ts.SourceFile, offset: number): string {
  const text = sourceFile.getFullText();
  let start = offset;
  while (start > 0 && text[start - 1] !== '\n') start--;
  return /^[ \t]*/.exec(text.slice(start, offset))?.[0] ?? '';
}

/**
 * Where to put a new element in a parenthesised, comma-separated list,
 * and what to write there. `listPos` is the NodeArray's `pos`, which the
 * parser sets just past the open parenthesis — the only offset available
 * when the list is empty. A list already broken across lines gets the
 * new element on its own line at the same indentation, so the shape of
 * an existing signature survives gaining a parameter.
 */
function insertionInto(
  sourceFile: ts.SourceFile,
  listPos: number,
  items: readonly ts.Node[],
  index: number,
  text: string,
): { offset: number; newText: string } {
  if (items.length === 0) return { offset: listPos, newText: text };
  const first = items[0]!.getStart(sourceFile);
  const multiline = sourceFile.getFullText().slice(listPos, first).includes('\n');
  const indent = multiline ? indentationAt(sourceFile, first) : '';
  if (index < items.length) {
    return {
      offset: items[index]!.getStart(sourceFile),
      newText: multiline ? `${text},\n${indent}` : `${text}, `,
    };
  }
  return {
    offset: items[items.length - 1]!.getEnd(),
    newText: multiline ? `,\n${indent}${text}` : `, ${text}`,
  };
}

function isThisParameter(parameter: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(parameter.name) && parameter.name.text === 'this';
}

/** A comma expression put in an argument list would read as two arguments. */
function guarded(expression: ts.Expression, text: string): string {
  return ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.CommaToken
    ? `(${text})`
    : text;
}

/**
 * Names `captureConflicts` calls "different" that are in fact the same
 * binding at both ends.
 *
 * Measured, because it is not guessable: for a module-level *exported*
 * binding referenced from its own file, `getSymbolAtLocation` yields the
 * local symbol while `getSymbolsInScope` yields a distinct `ExportValue`
 * symbol wrapping the very same declaration. Comparing the two by
 * identity — which is what `captureConflicts` does, and rightly, since
 * identity is the only thing that separates two bindings of one name —
 * therefore refuses every expression built from an exported helper whose
 * caller lives in the same module. Two symbols sharing a declaration are
 * one binding, so that is the test used to drop the spurious ones, and
 * only those: a genuine shadow declares its own.
 */
function sameBindingAt(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  site: ts.Node,
  names: ReadonlySet<string>,
): Set<string> {
  const atSite = new Map<string, ts.Symbol>();
  for (const symbol of checker.getSymbolsInScope(site, ts.SymbolFlags.All)) {
    if (!atSite.has(symbol.name)) atSite.set(symbol.name, unalias(checker, symbol));
  }
  const same = new Set<string>();
  for (const identifier of rootIdentifiers(expression)) {
    if (!names.has(identifier.text)) continue;
    const declared = checker.getSymbolAtLocation(identifier);
    const there = atSite.get(identifier.text);
    if (!declared || !there) continue;
    const here = unalias(checker, declared);
    const mine = new Set<ts.Declaration>(here.declarations ?? []);
    if ((there.declarations ?? []).some((declaration) => mine.has(declaration))) {
      same.add(identifier.text);
    }
  }
  return same;
}

/** Whether the declaration is reachable from outside this project. */
function isExported(declaration: ts.Node): boolean {
  for (let current: ts.Node | undefined = declaration; current; current = current.parent) {
    if (
      current.parent &&
      ts.isSourceFile(current.parent) &&
      ts.getCombinedModifierFlags(current as ts.Declaration) & ts.ModifierFlags.Export
    ) {
      return true;
    }
  }
  return false;
}

export const introduceParameter: Tool<
  IntroduceParameterInput,
  IntroduceParameterOutput,
  TsProjectSession
> = {
  name: 'ts/refactors/introduce-parameter',
  description:
    'Turns an expression inside a function into a new parameter, replacing every structurally ' +
    'identical occurrence in the body with the parameter name and passing the original ' +
    'expression at every call site project-wide. The expression is addressed by its own code ' +
    '(`select`, with `within` naming the enclosing function when it occurs in more than one), ' +
    'never by offsets. The parameter type is the widened type the checker gives the ' +
    'expression, and the argument goes at the slot the resolved signature reports, so a ' +
    '`this` parameter cannot shift it. Given `defaultValue` the parameter is optional and no ' +
    'call site is touched, which keeps an exported function source-compatible. Refuses when ' +
    'the expression depends on a parameter or local of the function, when it means something ' +
    'different at a call site, when an expression that could do something observable occurs ' +
    'more than once, when the body assigns to it, on `this`/`super`/`arguments`, when the ' +
    'callee is handed out as a value (arr.map(f), .call/.apply/.bind) where arity is checked ' +
    'by assignability, on spread calls, overload sets, recursion, a method the class ' +
    'hierarchy shares, and a call that omits optional arguments before the new slot. ' +
    'Dry-run by default; apply: true writes unless the in-memory typecheck reports ' +
    'newDiagnostics.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'File the expression lives in' },
      ...SELECTION_PROPERTIES,
      name: { type: 'string', description: 'Name for the new parameter' },
      position: {
        description:
          "Where the parameter goes among the value parameters (a `this` parameter is not one): 'append' or a zero-based index",
        oneOf: [{ type: 'string', enum: ['append'] }, { type: 'integer', minimum: 0 }],
      },
      defaultValue: {
        type: 'string',
        description:
          'Expression to default the parameter to; makes it optional and leaves call sites alone',
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    required: ['file', 'select', 'name'],
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      callSites: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            line: { type: 'integer' },
            character: { type: 'integer' },
          },
          required: ['file', 'line', 'character'],
        },
      },
      occurrences: { type: 'integer' },
    },
    ['callSites', 'occurrences'],
  ),

  async run(session, input) {
    if (!IDENTIFIER.test(input.name)) {
      throw new Error(`"${input.name}" is not a valid identifier`);
    }

    const file = path.resolve(session.rootPath, input.file);
    const sourceFile = session.program().getSourceFile(file);
    if (!sourceFile) throw new Error(`${file} is not a source file in this project`);

    const defaultText = input.defaultValue?.trim();
    const parsedDefault =
      input.defaultValue === undefined ? undefined : parseExpression(input.defaultValue);
    if (input.defaultValue !== undefined && !parsedDefault) {
      throw new Error(`defaultValue ${JSON.stringify(input.defaultValue)} is not a single expression`);
    }

    // `locateSelection` is the addressing authority for every other
    // selection-shaped tool and it refuses a selection that occurs more
    // than once — which is precisely the case this tool exists to serve,
    // since the parameter replaces *every* occurrence. So the matching
    // is done here over the same token keys, and `locateSelection` is
    // asked only when nothing matched, because its refusals name exactly
    // what is wrong with the selection.
    const selected = parseExpression(input.select);
    const key = selected ? tokenKey(selected.node, selected.file) : undefined;

    const matches: ts.Expression[] = [];
    if (key !== undefined) {
      const visit = (node: ts.Node): void => {
        if (
          ts.isExpression(node) &&
          !isNamePosition(node) &&
          !insideType(node) &&
          tokenKey(node, sourceFile) === key
        ) {
          matches.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    if (matches.length === 0) {
      // Throws with the right diagnosis for an unparseable, misspelled,
      // or non-node selection; succeeds only when the selection names
      // something that is not an expression at all.
      const located = locateSelection(session, {
        file: input.file,
        select: input.select,
        ...(input.within === undefined ? {} : { within: input.within }),
      });
      if (located.kind !== 'expression') {
        throw new Error(
          `That selection is a ${located.kind === 'statements' ? 'statement run' : 'type'} at ` +
            `${input.file}:${located.line}. Introduce Parameter needs an expression: a value the ` +
            'function computes, which a caller could pass instead.',
        );
      }
      // `locateSelection` sees it and this tool does not, so every
      // occurrence is somewhere a name is not a value.
      throw new Error(
        `That selection occurs at ${input.file}:${located.line} only where it names something ` +
          'rather than computing a value — a property name, or a name inside a type — so there ' +
          'is nothing for a caller to pass.',
      );
    }

    const sited: { node: ts.Expression; callable: CallableDeclaration; name: ts.Identifier }[] = [];
    for (const node of matches) {
      const target = targetCallable(node);
      if (!target) continue;
      if (input.within !== undefined && target.name.text !== input.within) continue;
      sited.push({ node, callable: target.callable, name: target.name });
    }
    if (sited.length === 0) {
      const lines = matches
        .map((node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1)
        .join(', ');
      throw new Error(
        input.within !== undefined
          ? `No occurrence of that selection sits in the body of a function named "${input.within}" in ${input.file} (found at lines ${lines})`
          : `That selection is not inside the body of a named function in ${input.file} (found at lines ${lines}); ` +
            'an anonymous callback, a parameter default, and module scope all have no signature to add a parameter to',
      );
    }

    const containers = [...new Set(sited.map((match) => match.callable))];
    if (containers.length > 1) {
      const names = containers
        .map((callable) => {
          const line =
            sourceFile.getLineAndCharacterOfPosition(callable.getStart(sourceFile)).line + 1;
          return `${nameOfCallable(callable)?.text ?? '(anonymous)'} at line ${line}`;
        })
        .join(', ');
      throw new Error(
        `That selection occurs in ${String(containers.length)} functions in ${input.file} (${names}). ` +
          'Narrow it with "within".',
      );
    }

    const { callable, name: nameNode } = sited[0]!;
    const calleeName = nameNode.text;
    const declarationFile = callable.getSourceFile();
    if (declarationFile.isDeclarationFile) {
      throw new Error(`${declarationFile.fileName} is a declaration file, which has no body`);
    }
    const expression = sited[0]!.node;
    const expressionText = expression.getText(sourceFile);
    const occurrences = sited.map((match) => match.node);

    // `this` is the receiver, `arguments` is the real argument list this
    // edit lengthens, and `super` is bound to the declaring class —
    // none of them survives being evaluated at a call site.
    let bound: string | undefined;
    const findBound = (node: ts.Node): void => {
      if (bound) return;
      if (node.kind === ts.SyntaxKind.ThisKeyword) bound = 'this';
      else if (node.kind === ts.SyntaxKind.SuperKeyword) bound = 'super';
      else if (ts.isMetaProperty(node)) bound = 'new.target';
      else if (ts.isIdentifier(node) && node.text === 'arguments' && !isNamePosition(node)) {
        bound = 'arguments';
      }
      ts.forEachChild(node, findBound);
    };
    findBound(expression);
    if (bound) {
      throw new Error(
        `${expressionText} reads \`${bound}\`, which is bound to "${calleeName}" itself and means something else at a call site`,
      );
    }

    const written = occurrences.find((node) => isWriteTarget(node));
    if (written) {
      throw new Error(
        `The body of "${calleeName}" assigns to ${expressionText} at ` +
          `${locationOf(sourceFile, written.getStart(sourceFile))}; a parameter would take the ` +
          'assignment with it and the original would stop being written',
      );
    }

    if (occurrences.length > 1 && mayHaveEffects(expression)) {
      throw new Error(
        `${expressionText} could do something observable and occurs ${String(occurrences.length)} times in "${calleeName}"; ` +
          'a parameter is evaluated once, so the remaining evaluations would disappear',
      );
    }

    // A name that already means something inside the function would be
    // shadowed by the parameter, which compiles and silently rebinds.
    const replaced = new Set(occurrences);
    let collision: ts.Identifier | undefined;
    const findCollision = (node: ts.Node): void => {
      if (collision || replaced.has(node as ts.Expression)) return;
      if (ts.isIdentifier(node) && node.text === input.name) collision = node;
      ts.forEachChild(node, findCollision);
    };
    findCollision(callable);
    if (collision) {
      throw new Error(
        `"${input.name}" already means something inside "${calleeName}" (${locationOf(sourceFile, collision.getStart(sourceFile))}); ` +
          'a parameter of that name would shadow it',
      );
    }

    const checker = session.checker();

    // The expression has to be evaluable where the caller stands. A
    // parameter or local of the callee never is — and unlike a name that
    // is merely absent, which the guard reports as TS2304, this one is
    // worth naming precisely, because the fix is to select a different
    // expression rather than to add an import.
    for (const identifier of rootIdentifiers(expression)) {
      const symbol = checker.getSymbolAtLocation(identifier);
      for (const declaration of symbol?.declarations ?? []) {
        if (
          declaration.getSourceFile() === declarationFile &&
          declaration.getStart() >= callable.getStart(declarationFile) &&
          declaration.getEnd() <= callable.getEnd()
        ) {
          throw new Error(
            `${expressionText} depends on "${identifier.text}", which "${calleeName}" declares ` +
              `(${locationOf(declarationFile, declaration.getStart(declarationFile))}), so a caller ` +
              'cannot evaluate it',
          );
        }
      }
    }

    // An overload set spreads one implementation across several
    // parameter lists, so a single list's edit describes none of the
    // call sites.
    const symbol = checker.getSymbolAtLocation(nameNode);
    const signatures = (symbol?.declarations ?? []).filter(
      (node) => callableOf(node) !== undefined,
    );
    if (signatures.length > 1) {
      throw new Error(
        `"${calleeName}" is an overload set (${String(signatures.length)} declarations); its parameter lists must change together`,
      );
    }

    if (ts.isMethodDeclaration(callable)) {
      const hierarchy = memberHierarchy(session, callable);
      if (hierarchy.unresolved.length > 0) {
        throw new Error(
          `The class hierarchy around "${calleeName}" cannot be resolved (${hierarchy.unresolved.join('; ')}), so the set of declarations sharing this signature is unknown`,
        );
      }
      const related = [...hierarchy.supertypes, ...hierarchy.subtypes];
      if (related.length > 0) {
        throw new Error(
          `"${calleeName}" shares its signature with other declarations; they must change together:\n  ` +
            related
              .map((member) => `${member.container} at ${member.file}:${member.line + 1}`)
              .join('\n  '),
        );
      }
    }

    // References first: one escape invalidates every conclusion drawn
    // from the call sites. An optional parameter is assignment-safe, but
    // an escaped callee is *called* by whoever holds it — `lines.map(f)`
    // would start feeding map's index into the new parameter — so this
    // is refused in the defaultValue form too.
    const survey = surveyCallSites(session, file, nameNode.getStart(sourceFile), calleeName);
    assertOnlyCalls(calleeName, survey, `adding "${input.name}" to "${calleeName}"`);

    const valueParameters = callable.parameters.filter((p) => !isThisParameter(p));
    const index =
      input.position === undefined || input.position === 'append'
        ? valueParameters.length
        : input.position;
    if (!Number.isInteger(index) || index < 0 || index > valueParameters.length) {
      throw new Error(
        `position ${JSON.stringify(input.position)} is outside "${calleeName}"'s ${String(valueParameters.length)} value parameters`,
      );
    }

    const type = checker.getWidenedType(
      checker.getBaseTypeOfLiteralType(checker.getTypeAtLocation(expression)),
    );
    const annotation = checker.typeToString(type, callable, ts.TypeFormatFlags.NoTruncation);
    // With an enclosing declaration TypeScript falls back to
    // `import("/absolute/path").T` for a type whose name is not in scope
    // there. That compiles — so the guard is blind to it — while writing
    // a machine-specific path into the user's source.
    if (annotation.includes('import(')) {
      throw new Error(
        `The type of ${expressionText} cannot be named in ${path.relative(session.rootPath, declarationFile.fileName)} ` +
          `(the checker prints it as ${annotation}); import the type there first`,
      );
    }

    const changes = new Map<string, TextEdit[]>();
    const editIn = (target: ts.SourceFile, start: number, end: number, newText: string): void => {
      const edited = path.resolve(target.fileName);
      const edits = changes.get(edited) ?? [];
      edits.push({
        range: {
          start: target.getLineAndCharacterOfPosition(start),
          end: target.getLineAndCharacterOfPosition(end),
        },
        newText,
      });
      changes.set(edited, edits);
    };

    const declared =
      `${input.name}: ${annotation}` +
      (parsedDefault && defaultText ? ` = ${guarded(parsedDefault.node, defaultText)}` : '');
    const declarationIndex =
      index < valueParameters.length
        ? callable.parameters.indexOf(valueParameters[index]!)
        : callable.parameters.length;
    const slot = insertionInto(
      declarationFile,
      callable.parameters.pos,
      callable.parameters,
      declarationIndex,
      declared,
    );
    editIn(declarationFile, slot.offset, slot.offset, slot.newText);

    for (const occurrence of occurrences) {
      const parent = occurrence.parent as ts.Node | undefined;
      // `{ x }` is both the property name and its value, so replacing
      // the identifier outright would rename the property.
      const newText =
        parent && ts.isShorthandPropertyAssignment(parent) && parent.name === occurrence
          ? `${expressionText}: ${input.name}`
          : input.name;
      editIn(sourceFile, occurrence.getStart(sourceFile), occurrence.getEnd(), newText);
    }

    const argument = guarded(expression, expressionText);
    const callSites: CallSitePosition[] = [];
    const warnings: string[] = [];
    for (const reference of survey.calls) {
      const { call, sourceFile: callFile } = resolveCall(checker, reference, callable, calleeName);
      const where = locationOf(callFile, call.getStart(callFile));
      // A self-call is both a call site to rewrite and a place an
      // occurrence may sit, and the two edits describe the same text.
      if (
        callFile === declarationFile &&
        call.getStart(callFile) >= callable.getStart(declarationFile) &&
        call.getEnd() <= callable.getEnd()
      ) {
        throw new Error(
          `"${calleeName}" calls itself at ${where}; that call is inside the body this edit rewrites`,
        );
      }
      callSites.push({
        file: path.resolve(callFile.fileName),
        line: reference.line,
        character: reference.character,
      });

      if (parsedDefault) {
        // Nothing is written here, so an argument already in this slot
        // would start feeding the new parameter instead of the one it
        // was written for. Two compatible types make that compile.
        if (index < (call.arguments?.length ?? 0)) {
          throw new Error(
            `The call at ${where} already passes an argument at slot ${String(index)}, and a ` +
              'defaulted parameter leaves call sites alone, so that argument would silently ' +
              `become "${input.name}"; append the parameter instead`,
          );
        }
        continue;
      }

      // The expression stops being evaluated in the callee and starts
      // being evaluated here. A name missing at this site is TS2304 from
      // the guard; a name that resolves to something *else* compiles
      // silently, which is the case the guard cannot see.
      const reported = captureConflicts(checker, expression, call, new Set());
      const spurious = sameBindingAt(
        checker,
        expression,
        call,
        new Set(reported.filter((c) => c.reason === 'different').map((c) => c.name)),
      );
      const conflicts = reported.filter((conflict) => !spurious.has(conflict.name));
      if (conflicts.length > 0) {
        const missing = conflicts.filter((conflict) => conflict.reason === 'missing');
        const shadowed = conflicts.filter((conflict) => conflict.reason === 'different');
        throw new Error(
          `${expressionText} cannot be evaluated at ${where}: ` +
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

      const args = call.arguments;
      if (!args) {
        throw new Error(
          `The call at ${where} has no argument list, so there is nowhere to pass ${expressionText}`,
        );
      }
      if (index > args.length) {
        throw new Error(
          `The call at ${where} passes ${String(args.length)} argument${args.length === 1 ? '' : 's'} and ` +
            `omits the optional ones before "${input.name}"'s slot (${String(index)}); give the parameter a ` +
            'defaultValue, or place it earlier',
        );
      }
      const at = insertionInto(callFile, args.pos, args, index, argument);
      editIn(callFile, at.offset, at.offset, at.newText);
    }

    if (mayHaveEffects(expression)) {
      warnings.push(
        parsedDefault
          ? `${expressionText} could do something observable; it now runs as "${input.name}"'s default, once per call that omits it, rather than where it sat in the body`
          : `${expressionText} could do something observable; it now runs at each call site, before "${calleeName}" is entered, rather than where it sat in the body`,
      );
    }
    if (parsedDefault && tokenKey(parsedDefault.node, parsedDefault.file) !== key) {
      warnings.push(
        `Existing callers pass nothing, so "${calleeName}" now evaluates ${defaultText ?? ''} where its body evaluated ${expressionText}; confirm the two agree`,
      );
    }
    if (!parsedDefault && isExported(callable)) {
      warnings.push(
        `"${calleeName}" is exported and "${input.name}" is required, so callers outside this project must be updated; the typecheck only sees the ${String(callSites.length)} call site${callSites.length === 1 ? '' : 's'} in it`,
      );
    }

    const edit: WorkspaceEdit = { changes: Object.fromEntries(changes) };
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output: IntroduceParameterOutput = {
      applied: false,
      edit,
      filesChanged: filesTouched(edit),
      newDiagnostics,
      warnings,
      callSites,
      occurrences: occurrences.length,
    };
    if (input.apply !== true || newDiagnostics.length > 0) return output;

    session.invalidate(await applyWorkspaceEdit(edit));
    return { ...output, applied: true };
  },
};
