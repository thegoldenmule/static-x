import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { memberHierarchy } from '../../ast/hierarchy.js';
import { classifyReferences } from '../references.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import {
  argumentIndexOf,
  assertOnlyCalls,
  callableOf,
  locationOf,
  resolveCall,
  surveyCallSites,
} from '../signatures.js';
import {
  captureConflicts,
  mayHaveEffects,
  needsParentheses,
  substituteExpression,
} from '../substitution.js';

/**
 * Replaces calls to a function with its body and deletes the
 * declaration — ReSharper's Inline Method.
 *
 * TypeScript ships nothing for this, and its nearest relative, `Inline
 * variable`, is wrong in three ways a typecheck cannot see. So the
 * substitution machinery this is built on exists precisely to get those
 * three right: parentheses come from the compiler's own parenthesizer,
 * every name the body depends on is re-resolved at each call site, and
 * an impure expression is never duplicated.
 *
 * **This tool refuses a lot, and that is the design.** It inlines a
 * function whose body is a single expression, and declines the rest —
 * multiple statements, control flow, anything whose meaning depends on
 * where it runs. The alternative to refusing is not that the caller
 * waits: it is that the model inlines by hand, gets `c - a - b` where
 * `c - (a - b)` was meant, and `tsc` says nothing.
 */

export interface InlineFunctionInput {
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  /** Keep the declaration instead of deleting it. Default false. */
  keepDeclaration?: boolean;
  apply?: boolean;
}

export interface InlineSite {
  file: string;
  line: number;
  character: number;
  /** The text the call is replaced with. */
  inlined: string;
}

export interface InlineFunctionOutput extends RefactorOutput {
  /** Every call the edit replaces, with what it becomes. */
  callSites: InlineSite[];
  /** The body expression that was inlined. */
  body: string | undefined;
}

/** The single expression a body amounts to, or undefined. */
function soleExpression(callable: ts.FunctionLikeDeclaration): ts.Expression | undefined {
  const body = callable.body;
  if (!body) return undefined;
  if (!ts.isBlock(body)) return body; // expression-bodied arrow
  if (body.statements.length !== 1) return undefined;
  const only = body.statements[0]!;
  return ts.isReturnStatement(only) ? only.expression : undefined;
}

/** How many times the body reads each parameter. */
function readCounts(body: ts.Expression, names: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text)) {
      const parent = node.parent as ts.Node | undefined;
      const isName =
        parent !== undefined &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node));
      if (!isName) counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return counts;
}

/** Every import specifier that binds the target symbol. */
function classifyImportBindings(
  session: TsProjectSession,
  file: string,
  offset: number,
): { node: ts.Node; sourceFile: ts.SourceFile }[] {
  return classifyReferences(session, file, offset)
    .filter((reference) => reference.kind === 'import-binding')
    .map((reference) => ({ node: reference.node, sourceFile: reference.node.getSourceFile() }));
}

/**
 * Remove the binding a file used to reach the inlined function.
 *
 * Once every call is gone the import names something that no longer
 * exists, which is a hard error rather than untidiness. Dropping the
 * whole statement when it bound nothing else keeps the file from
 * carrying an empty import clause.
 */
function removeBinding(reference: ts.Node, sourceFile: ts.SourceFile): TextEdit | undefined {
  const specifier = reference.parent;
  if (!specifier || !ts.isImportSpecifier(specifier)) return undefined;
  const named = specifier.parent;
  const clause = named.parent;
  const statement = clause.parent;
  const at = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset);

  if (named.elements.length > 1) {
    // Take the comma that joins it to a neighbour, so the list stays valid.
    const index = named.elements.indexOf(specifier);
    const start =
      index === 0
        ? specifier.getStart(sourceFile)
        : named.elements[index - 1]!.getEnd();
    const end =
      index === 0 ? named.elements[1]!.getStart(sourceFile) : specifier.getEnd();
    return { range: { start: at(start), end: at(end) }, newText: '' };
  }
  if (clause.name) {
    // `import Default, { only }` — the default binding stays.
    return {
      range: { start: at(clause.name.getEnd()), end: at(named.getEnd()) },
      newText: '',
    };
  }
  const text = sourceFile.getFullText();
  let end = statement.getEnd();
  while (end < text.length && text[end] !== '\n') end++;
  if (end < text.length) end++;
  return {
    range: { start: at(statement.getStart(sourceFile)), end: at(end) },
    newText: '',
  };
}

/** The span that removes a declaration along with its own line. */
function declarationSpan(
  declaration: ts.Node,
  sourceFile: ts.SourceFile,
): { start: number; end: number } {
  const start = declaration.getStart(sourceFile, true);
  const text = sourceFile.getFullText();
  let lineStart = start;
  while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart--;
  let end = declaration.getEnd();
  while (end < text.length && text[end] !== '\n') end++;
  if (end < text.length) end++;
  // A blank line left behind reads as a hole where the function was.
  if (text.slice(end, end + 1) === '\n') end++;
  return { start: lineStart, end };
}

export const inlineFunction: Tool<
  InlineFunctionInput,
  InlineFunctionOutput,
  TsProjectSession
> = {
  name: 'ts/refactors/inline-function',
  description:
    'Replaces every call to a function with its body and deletes the declaration — ' +
    "ReSharper's Inline Method. Targets a function, method, or arrow-valued const by name " +
    '(symbol) or exact position. Only a body that is a single expression is inlined: a return ' +
    'statement or an expression-bodied arrow. Arguments are matched to parameters through the ' +
    'checker-resolved signature, and parentheses come from the compiler, so `c - f(a, b)` with ' +
    'a body of `a - b` becomes `c - (a - b)` rather than the wrong `c - a - b`. Refuses when ' +
    'an argument that could do something observable would be duplicated, when a name in the ' +
    'body means something different at a call site (or nothing at all), when the callee is ' +
    'handed out as a value, on spread calls, overload sets, recursion, a body using `this`, ' +
    'and a method that overrides or implements another. Expect refusals: they are the point, ' +
    'because the failures being refused are ones a typecheck cannot see. Dry-run by default.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      keepDeclaration: {
        type: 'boolean',
        description: 'Leave the declaration in place (default false)',
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
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
            inlined: { type: 'string' },
          },
        },
      },
      body: { type: 'string' },
    },
    ['callSites'],
  ),

  async run(session, input) {
    const target = resolveTarget(session, input);
    const declaration = declarationAt(target);
    const callable = callableOf(declaration);
    if (!callable) {
      throw new Error(
        `${target.file}:${target.position.line + 1} is not a function, method, or arrow-valued const`,
      );
    }
    const calleeName =
      declaration.name && ts.isIdentifier(declaration.name) ? declaration.name.text : '(anonymous)';
    const declarationFile = callable.getSourceFile();
    if (declarationFile.isDeclarationFile) {
      throw new Error(`"${calleeName}" is declared in a .d.ts file, which has no body`);
    }

    const body = soleExpression(callable);
    if (!body) {
      throw new Error(
        `"${calleeName}" is not a single expression. Only a body that is one \`return\` — or an ` +
          'expression-bodied arrow — can be inlined without deciding what its statements mean ' +
          'at each call site.',
      );
    }
    if (callable.asteriskToken) {
      throw new Error(`"${calleeName}" is a generator, whose body cannot be an expression`);
    }

    const checker = session.checker();
    const parameters = callable.parameters.filter(
      (parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'),
    );
    if (parameters.some((parameter) => !ts.isIdentifier(parameter.name))) {
      throw new Error(`"${calleeName}" has a destructured parameter, which has no name to bind`);
    }
    if (parameters.some((parameter) => parameter.dotDotDotToken)) {
      throw new Error(`"${calleeName}" has a rest parameter, which collects a variable argument list`);
    }

    // `this` in the body means the receiver, which does not survive
    // being moved to the call site.
    let usesThis = false;
    const findThis = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.ThisKeyword) usesThis = true;
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return;
      ts.forEachChild(node, findThis);
    };
    findThis(body);
    if (usesThis) {
      throw new Error(`"${calleeName}" uses \`this\`, which means something else at a call site`);
    }

    const symbol = declaration.name ? checker.getSymbolAtLocation(declaration.name) : undefined;
    const declarations = (symbol?.declarations ?? []).filter((node) => callableOf(node) !== undefined);
    if (declarations.length > 1) {
      throw new Error(
        `"${calleeName}" is an overload set (${declarations.length} declarations), so a call may not resolve to this body`,
      );
    }
    if (ts.isMethodDeclaration(callable)) {
      const hierarchy = memberHierarchy(session, callable);
      if (hierarchy.unresolved.length > 0) {
        throw new Error(
          `"${calleeName}"'s class hierarchy cannot be resolved, so overrides may be invisible`,
        );
      }
      if (hierarchy.supertypes.length + hierarchy.subtypes.length > 0) {
        throw new Error(
          `"${calleeName}" is declared by other types in its hierarchy; inlining one of them would change what the others mean`,
        );
      }
    }

    const survey = surveyCallSites(session, target.file, target.offset, calleeName);
    assertOnlyCalls(calleeName, survey, `inlining "${calleeName}"`);
    if (survey.calls.length === 0) {
      throw new Error(`Nothing calls "${calleeName}", so there is nothing to inline into`);
    }
    // A body that calls the function it belongs to has no fixed point.
    for (const reference of survey.calls) {
      if (
        reference.node.getSourceFile() === declarationFile &&
        reference.node.getStart() >= callable.getStart(declarationFile) &&
        reference.node.getEnd() <= callable.getEnd()
      ) {
        throw new Error(`"${calleeName}" is recursive, so its body cannot replace its own call`);
      }
    }

    const parameterNames = new Set(
      parameters.map((parameter) => (parameter.name as ts.Identifier).text),
    );
    const uses = readCounts(body, parameterNames);

    const changes: Record<string, TextEdit[]> = {};
    const callSites: InlineSite[] = [];
    for (const reference of survey.calls) {
      const { call, sourceFile, signature } = resolveCall(checker, reference, callable, calleeName);
      const where = locationOf(sourceFile, call.getStart(sourceFile));

      const bindings = new Map<string, string>();
      for (const parameter of parameters) {
        const name = (parameter.name as ts.Identifier).text;
        const index = argumentIndexOf(signature, parameter);
        const argument = index === -1 ? undefined : call.arguments?.[index];
        const text = argument
          ? argument.getText(sourceFile)
          : parameter.initializer?.getText(declarationFile);
        if (text === undefined) {
          throw new Error(`The call at ${where} passes nothing for "${name}", which has no default`);
        }
        if (argument && (uses.get(name) ?? 0) > 1 && mayHaveEffects(argument)) {
          throw new Error(
            `The argument for "${name}" at ${where} could do something observable, and the body ` +
              `reads it ${String(uses.get(name))} times — inlining would evaluate it more than once`,
          );
        }
        bindings.set(name, text);
      }

      // Every name the body depends on has to still mean the same thing
      // here. A name that resolves to something different compiles and
      // silently changes behaviour; that is the case the guard is blind
      // to and the reason this check exists.
      const conflicts = captureConflicts(checker, body, call, parameterNames);
      if (conflicts.length > 0) {
        const missing = conflicts.filter((conflict) => conflict.reason === 'missing');
        const shadowed = conflicts.filter((conflict) => conflict.reason === 'different');
        throw new Error(
          `The body of "${calleeName}" cannot be evaluated at ${where}: ` +
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

      const substituted = substituteExpression(body, declarationFile, bindings);
      // The parenthesizer only saw inside the body; whether the result
      // survives where the call sat is a separate question.
      const inlined = needsParentheses(substituted.expression, call)
        ? `(${substituted.text})`
        : substituted.text;
      const file = path.resolve(sourceFile.fileName);
      changes[file] = [
        ...(changes[file] ?? []),
        {
          range: {
            start: sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)),
            end: sourceFile.getLineAndCharacterOfPosition(call.getEnd()),
          },
          newText: inlined,
        },
      ];
      callSites.push({
        file,
        line: reference.line,
        character: reference.character,
        inlined,
      });
    }

    if (input.keepDeclaration !== true) {
      // The bindings other files used to reach it now name nothing.
      const importBindings = classifyImportBindings(session, target.file, target.offset);
      for (const { node, sourceFile } of importBindings) {
        const removal = removeBinding(node, sourceFile);
        if (!removal) continue;
        const file = path.resolve(sourceFile.fileName);
        changes[file] = [...(changes[file] ?? []), removal];
      }

      const span = declarationSpan(
        ts.isVariableDeclaration(declaration) && declaration.parent.parent
          ? declaration.parent.parent
          : declaration,
        declarationFile,
      );
      const file = path.resolve(declarationFile.fileName);
      changes[file] = [
        ...(changes[file] ?? []),
        {
          range: {
            start: declarationFile.getLineAndCharacterOfPosition(span.start),
            end: declarationFile.getLineAndCharacterOfPosition(span.end),
          },
          newText: '',
        },
      ];
    }

    const edit: WorkspaceEdit = { changes };
    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const bodyText = body.getText(declarationFile);
    const output = {
      edit,
      filesChanged,
      newDiagnostics,
      warnings: [],
      callSites,
      body: bodyText,
    };

    if (input.apply !== true || newDiagnostics.length > 0) {
      return { applied: false, ...output };
    }
    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return { applied: true, ...output };
  },
};
