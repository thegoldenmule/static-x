import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { memberHierarchy } from '../../ast/hierarchy.js';
import { tokenKey } from '../../ast/structural.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { formatSettings } from '../refactor-action.js';
import {
  argumentIndexOf,
  assertOnlyCalls,
  callLikeOf,
  callableOf,
  surveyCallSites,
} from '../signatures.js';

/**
 * Inline Parameter: when every call site passes the same value for a
 * parameter, drop it from the signature and from every call, and bind
 * the value as a local at the top of the body.
 *
 * The precondition is whole-project knowledge — "every caller" is a
 * fact no single file contains — and the edit is authored here rather
 * than delegated: TypeScript's engine has no refactoring for it.
 */

export interface InlineParameterInput {
  /** Function, method, or arrow-valued const to change. */
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  /**
   * Parameter to inline: its name, or its zero-based index among the
   * value parameters — a `this` parameter is not one of them, because
   * it occupies no slot in the argument list.
   */
  parameter: string | number;
  /** Write the edit to disk. Default false: return the edit only. */
  apply?: boolean;
}

export interface CallSitePosition {
  file: string;
  line: number;
  character: number;
}

export interface InlineParameterOutput extends RefactorOutput {
  /** The common argument expression, as printed into the body. */
  value: string;
  /** Every call the edit rewrites, including those already omitting it. */
  callSites: CallSitePosition[];
}

function at(sourceFile: ts.SourceFile, offset: number): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
  return `${sourceFile.fileName}:${line + 1}:${character + 1}`;
}

function isThisParameter(parameter: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(parameter.name) && parameter.name.text === 'this';
}

/**
 * `arguments` sees the real argument list, which this refactoring
 * shortens by one. A nested non-arrow function binds its own, so the
 * walk stops at those rather than reporting them.
 */
function usesArguments(body: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      return;
    }
    if (ts.isIdentifier(node) && node.text === 'arguments') {
      const parent = node.parent as ts.Node | undefined;
      const isMemberName =
        parent !== undefined &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node));
      if (!isMemberName) {
        found = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  body.forEachChild(visit);
  return found;
}

/**
 * The span that deletes one element of a comma-separated list along
 * with the comma that joins it to its neighbours. Deleting forward to
 * the next element keeps that element's own leading layout; for the
 * last element there is no next, so the preceding comma is eaten
 * instead — which also preserves a trailing comma if the list has one.
 */
function removalRange(
  items: readonly ts.Node[],
  index: number,
  sourceFile: ts.SourceFile,
): { start: number; end: number } {
  const item = items[index]!;
  const next = items[index + 1];
  if (next) return { start: item.getStart(sourceFile), end: next.getStart(sourceFile) };
  const previous = items[index - 1];
  if (previous) return { start: previous.getEnd(), end: item.getEnd() };
  return { start: item.getStart(sourceFile), end: item.getEnd() };
}

function indentationAt(sourceFile: ts.SourceFile, offset: number): string {
  const text = sourceFile.getFullText();
  let start = offset;
  while (start > 0 && text[start - 1] !== '\n') start--;
  return /^[ \t]*/.exec(text.slice(start, offset))?.[0] ?? '';
}

/**
 * The whole source line (or lines) a JSDoc tag occupies. TypeScript
 * folds the newline and the next line's ` * ` prefix into a tag's end,
 * so the raw node range cuts a comment in half; trimming that trailing
 * trivia and then expanding to line boundaries removes the tag and
 * nothing else. Clamped inside the comment's own delimiters, so the
 * removal can never take the opener or the closer with it.
 */
function tagLineRange(
  sourceFile: ts.SourceFile,
  tag: ts.JSDocTag,
): { start: number; end: number } | undefined {
  const jsdoc = tag.parent as ts.Node | undefined;
  if (!jsdoc || !ts.isJSDoc(jsdoc)) return undefined;
  const text = sourceFile.getFullText();

  let last = tag.getEnd();
  while (last > tag.getStart(sourceFile) && /[\s*]/.test(text[last - 1]!)) last--;

  let start = tag.getStart(sourceFile);
  while (start > 0 && text[start - 1] !== '\n') start--;
  let end = last;
  while (end < text.length && text[end] !== '\n') end++;
  if (end < text.length) end++;

  start = Math.max(start, jsdoc.getStart(sourceFile) + 3);
  end = Math.min(end, jsdoc.getEnd() - 2);
  return end > start ? { start, end } : undefined;
}

/**
 * Identifiers the value expression is built from, chains reduced to
 * their root: `Level.Info` contributes `Level`, because `Info` is a
 * property name resolved through it rather than a name in scope.
 */
function rootIdentifiers(expression: ts.Node): ts.Identifier[] {
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

function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Whether evaluating the expression can do anything besides produce a value. */
function mayHaveEffects(expression: ts.Node): boolean {
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

interface ResolvedCall {
  call: ts.CallExpression | ts.NewExpression;
  sourceFile: ts.SourceFile;
  /** Index of the parameter in the resolved signature's argument list. */
  index: number;
  /** The argument passed, or undefined when the call omits it. */
  argument: ts.Expression | undefined;
}

export const inlineParameter: Tool<
  InlineParameterInput,
  InlineParameterOutput,
  TsProjectSession
> = {
  name: 'ts/refactors/inline-parameter',
  description:
    'Removes a parameter that every call site passes the same value for, and binds that ' +
    'value as a const at the top of the function body. Targets a function, method, or ' +
    'arrow-valued const by name (symbol) or exact position, plus the parameter by name or ' +
    'zero-based index. Arguments are matched to the parameter through the checker-resolved ' +
    'signature, not by counting commas, so a `this` parameter or an omitted optional cannot ' +
    'shift the mapping. Refuses when any call site passes a different value (naming that ' +
    'site), when the callee is handed out as a value (arr.map(f), .call/.apply/.bind, ' +
    'typeof f, a decorator, a JSX component) where arity is checked by assignability, on ' +
    'spread calls, overload sets, a method that overrides or implements another, a body ' +
    'using `arguments`, an expression-bodied arrow, a .d.ts declaration, and when the value ' +
    'names something the callee cannot see or that resolves differently there. Dry-run by ' +
    'default; apply: true writes. Output carries the inlined value and every call site ' +
    'rewritten; non-empty newDiagnostics means the edit was refused.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      parameter: {
        description:
          'Parameter to inline: its name, or its zero-based index among the value parameters (a `this` parameter is not one)',
        oneOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }],
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    required: ['parameter'],
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema({
    value: { type: 'string' },
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
  }),
  async run(session, input) {
    const checker = session.checker();
    const target = resolveTarget(session, input);
    const declaration = declarationAt(target);
    const declarationFile = declaration.getSourceFile();

    if (declarationFile.isDeclarationFile) {
      throw new Error(
        `${declarationFile.fileName} is a declaration file; it describes an implementation this project does not own`,
      );
    }

    const callable = callableOf(declaration);
    if (!callable) {
      throw new Error(
        `${at(declarationFile, target.offset)} is not a function, method, or arrow-valued const`,
      );
    }
    const nameNode = declaration.name;
    if (!nameNode || !ts.isIdentifier(nameNode)) {
      throw new Error('Only a callable with an identifier name can be targeted');
    }
    const calleeName = nameNode.text;

    // An overload set shares one implementation across several parameter
    // lists, so a single list's edit describes none of the call sites.
    const symbol = checker.getSymbolAtLocation(nameNode);
    const signatureDeclarations = (symbol?.declarations ?? []).filter(
      (node) => callableOf(node) !== undefined,
    );
    if (signatureDeclarations.length > 1) {
      throw new Error(
        `"${calleeName}" is an overload set (${String(signatureDeclarations.length)} declarations); its parameter lists must change together`,
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
        const sharedWith = related
          .map((member) => `${member.container} at ${member.file}:${member.line + 1}`)
          .join('\n  ');
        throw new Error(
          `"${calleeName}" shares its signature with other declarations; they must change together:\n  ${sharedWith}`,
        );
      }
    }

    const body = callable.body;
    if (!body) {
      throw new Error(`"${calleeName}" has no body, so there is nowhere to bind the value`);
    }
    if (!ts.isBlock(body)) {
      throw new Error(
        `"${calleeName}" is an expression-bodied arrow; wrap its body in a block first — introducing a statement into a concise body is not implemented`,
      );
    }
    if (usesArguments(body)) {
      throw new Error(
        `"${calleeName}" reads \`arguments\`, which sees the real argument list this edit shortens`,
      );
    }

    // `this` is declared in the parameter list but passed as the
    // receiver, so it is not addressable and not indexable.
    const valueParameters = callable.parameters.filter((p) => !isThisParameter(p));
    const parameter =
      typeof input.parameter === 'number'
        ? valueParameters[input.parameter]
        : valueParameters.find(
            (p) => ts.isIdentifier(p.name) && p.name.text === input.parameter,
          );
    if (!parameter) {
      const names = valueParameters.map((p) => p.name.getText(declarationFile)).join(', ');
      throw new Error(
        `"${calleeName}" has no parameter ${JSON.stringify(input.parameter)}; its parameters are: ${names || '(none)'}`,
      );
    }
    if (!ts.isIdentifier(parameter.name)) {
      throw new Error(
        'A destructured parameter binds several names; inline them one binding at a time instead',
      );
    }
    if (parameter.dotDotDotToken) {
      throw new Error(`"${parameter.name.text}" is a rest parameter and collects many arguments`);
    }
    if (parameter.modifiers && parameter.modifiers.length > 0) {
      throw new Error(
        `"${parameter.name.text}" is a parameter property; removing it would also remove the field it declares`,
      );
    }
    const parameterName = parameter.name.text;

    // References first: a single escape invalidates every conclusion
    // drawn from the call sites, so it is checked before them.
    const survey = surveyCallSites(session, target.file, target.offset, calleeName);
    assertOnlyCalls(calleeName, survey, `dropping "${parameterName}"`);
    const uses = survey.uses;

    const resolved: ResolvedCall[] = [];
    for (const reference of uses) {
      const call = callLikeOf(reference.node);
      if (!call) {
        throw new Error(
          `Cannot find the call at ${reference.file}:${reference.line + 1}:${reference.character + 1}`,
        );
      }
      const sourceFile = call.getSourceFile();
      const signature = checker.getResolvedSignature(call);
      // The parameter's argument is at its index in the *resolved*
      // signature, which drops `this` and reflects the overload that
      // actually applies — counting commas in the declaration is how a
      // signature refactoring silently rewrites the wrong argument.
      if (!signature || signature.declaration !== callable) {
        throw new Error(
          `The call at ${at(sourceFile, call.getStart(sourceFile))} does not resolve to "${calleeName}"`,
        );
      }
      const index = argumentIndexOf(signature, parameter);
      if (index === -1) {
        throw new Error(
          `"${parameterName}" has no slot in the signature resolved at ${at(sourceFile, call.getStart(sourceFile))}`,
        );
      }
      const args = call.arguments ?? [];
      if (args.some((argument) => ts.isSpreadElement(argument))) {
        throw new Error(
          `The call at ${at(sourceFile, call.getStart(sourceFile))} spreads its arguments, so which one feeds "${parameterName}" is a runtime fact`,
        );
      }
      resolved.push({ call, sourceFile, index, argument: args[index] });
    }

    if (resolved.length === 0) {
      throw new Error(
        `Nothing calls "${calleeName}", so there is no common value to inline; delete the parameter instead`,
      );
    }

    // One value per call, an omitted argument standing for the default
    // the callee would have applied.
    const values = resolved.map((entry) => {
      if (entry.argument) {
        return {
          entry,
          node: entry.argument,
          sourceFile: entry.sourceFile,
          text: entry.argument.getText(entry.sourceFile),
        };
      }
      if (!parameter.initializer) {
        throw new Error(
          `The call at ${at(entry.sourceFile, entry.call.getStart(entry.sourceFile))} omits "${parameterName}", which has no default, so the value it passes is undefined only by absence`,
        );
      }
      return {
        entry,
        node: parameter.initializer,
        sourceFile: declarationFile,
        text: parameter.initializer.getText(declarationFile),
      };
    });

    const keyed = values.map((value) => ({
      ...value,
      key: tokenKey(value.node, value.sourceFile),
    }));
    const common = keyed[0]!;
    const divergent = keyed.filter((value) => value.key !== common.key);
    if (divergent.length > 0) {
      const disagreeing = divergent
        .map(
          (value) =>
            `${at(value.entry.sourceFile, value.entry.call.getStart(value.entry.sourceFile))} passes ${value.text}`,
        )
        .join('\n  ');
      throw new Error(
        `Call sites disagree about "${parameterName}": ${common.text} at ${at(common.entry.sourceFile, common.entry.call.getStart(common.entry.sourceFile))}, but\n  ${disagreeing}`,
      );
    }

    // The value moves from the caller's scope into the callee's. A name
    // missing there is caught by the guard as TS2304; a name that
    // exists there but means something else is not, so it is checked
    // by symbol identity here.
    const inScope = new Map<string, ts.Symbol>();
    for (const scoped of checker.getSymbolsInScope(body, ts.SymbolFlags.Value)) {
      if (!inScope.has(scoped.name)) inScope.set(scoped.name, unalias(checker, scoped));
    }
    for (const identifier of rootIdentifiers(common.node)) {
      const outer = checker.getSymbolAtLocation(identifier);
      const inner = inScope.get(identifier.text);
      if (!outer || !inner || unalias(checker, outer) !== inner) {
        throw new Error(
          `"${identifier.text}" in ${common.text} names something "${calleeName}" cannot see, or something else entirely, in ${declarationFile.fileName}`,
        );
      }
    }

    const changes = new Map<string, TextEdit[]>();
    const editIn = (sourceFile: ts.SourceFile, start: number, end: number, newText: string) => {
      const file = path.resolve(sourceFile.fileName);
      const edits = changes.get(file) ?? [];
      edits.push({
        range: {
          start: sourceFile.getLineAndCharacterOfPosition(start),
          end: sourceFile.getLineAndCharacterOfPosition(end),
        },
        newText,
      });
      changes.set(file, edits);
    };

    const parameterIndex = callable.parameters.indexOf(parameter);
    const parameterSpan = removalRange(callable.parameters, parameterIndex, declarationFile);
    editIn(declarationFile, parameterSpan.start, parameterSpan.end, '');

    // The `@param` line outlives the parameter otherwise, and
    // ts/comments/stale-refs flags it the moment this tool is done.
    let description: string | undefined;
    for (const tag of ts.getJSDocParameterTags(parameter)) {
      const range = tagLineRange(declarationFile, tag);
      if (!range) continue;
      description ??= ts.getTextOfJSDocComment(tag.comment)?.replace(/\s+/g, ' ').trim();
      editIn(declarationFile, range.start, range.end, '');
    }

    const settings = formatSettings(session);
    const unit = settings.convertTabsToSpaces
      ? ' '.repeat(settings.indentSize ?? 2)
      : '\t';
    const outerIndent = indentationAt(declarationFile, declaration.getStart(declarationFile));
    const firstStatement = body.statements[0];
    const innerIndent = firstStatement
      ? indentationAt(declarationFile, firstStatement.getStart(declarationFile))
      : outerIndent + unit;
    // A required parameter's annotation is exactly the name's type
    // inside the body, so carrying it over preserves it: inference
    // alone narrows `number` to `5`. An optional parameter's body type
    // also includes undefined, which its annotation does not say, and
    // an unannotated one has nothing to carry — both fall back to
    // inference, with the guard checking what that produced.
    const annotation =
      parameter.type && !parameter.questionToken
        ? `: ${parameter.type.getText(declarationFile)}`
        : '';
    const doc = description ? `/** ${description} */\n${innerIndent}` : '';
    const binding = `\n${innerIndent}${doc}const ${parameterName}${annotation} = ${common.text};`;
    const braceEnd = body.getStart(declarationFile) + 1;
    editIn(
      declarationFile,
      braceEnd,
      braceEnd,
      firstStatement ? binding : `${binding}\n${outerIndent}`,
    );

    const callSites: CallSitePosition[] = [];
    for (const entry of resolved) {
      const start = entry.call.getStart(entry.sourceFile);
      const position = entry.sourceFile.getLineAndCharacterOfPosition(start);
      callSites.push({
        file: path.resolve(entry.sourceFile.fileName),
        line: position.line,
        character: position.character,
      });
      // A call already omitting the argument reads the default, which
      // the binding now supplies; there is nothing to delete.
      if (!entry.argument) continue;
      const span = removalRange(entry.call.arguments ?? [], entry.index, entry.sourceFile);
      editIn(entry.sourceFile, span.start, span.end, '');
    }

    const edit: WorkspaceEdit = { changes: Object.fromEntries(changes) };
    const filesChanged = filesTouched(edit);
    const warnings = mayHaveEffects(common.node)
      ? [
          `${common.text} is evaluated inside "${calleeName}" now rather than at each call; confirm it has no side effects that depended on running there`,
        ]
      : [];

    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output: InlineParameterOutput = {
      applied: false,
      edit,
      filesChanged,
      newDiagnostics,
      warnings,
      value: common.text,
      callSites,
    };
    if (!input.apply || newDiagnostics.length > 0) return output;

    session.invalidate(await applyWorkspaceEdit(edit));
    return { ...output, applied: true };
  },
};
