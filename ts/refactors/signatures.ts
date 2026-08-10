import ts from 'typescript';
import type { TsProjectSession } from '../project/index.js';
import { classifyReferences, isUse, type ClassifiedReference } from './references.js';

/**
 * What every refactoring that edits a parameter list has to establish
 * before it edits anything: that the function is only ever *called*,
 * and which argument feeds which parameter.
 *
 * Both are places where a plausible shortcut is wrong. A function
 * handed out as a value has its arity checked by assignability rather
 * than at a call, so changing the signature there compiles and
 * misbehaves — the failure the in-memory typecheck cannot see, and the
 * reason an escape is a refusal rather than a warning. And an
 * argument's position is not the parameter's index in the declaration:
 * a `this` parameter shifts it, and an omitted optional means the
 * argument may not be there at all. The resolved signature is the only
 * authority on that, and counting commas is how a signature
 * refactoring silently rewrites the wrong argument.
 */

export type CallableDeclaration =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;

/** The callable a resolved declaration denotes, for all TS forms. */
export function callableOf(declaration: ts.Node): CallableDeclaration | undefined {
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isArrowFunction(declaration)
  ) {
    return declaration;
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const initializer = declaration.initializer;
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
      return initializer;
    }
  }
  return undefined;
}

/** The call a reference to the callee forms, through property accesses. */
export function callLikeOf(node: ts.Node): ts.CallExpression | ts.NewExpression | undefined {
  let current: ts.Node = node;
  while (current.parent) {
    const parent: ts.Node = current.parent;
    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.expression === current
    ) {
      return parent;
    }
    if (
      ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      current = parent;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** `file:line:column`, one-based, as refusal messages report it. */
export function locationOf(sourceFile: ts.SourceFile, offset: number): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
  return `${sourceFile.fileName}:${line + 1}:${character + 1}`;
}

export function describeReferences(references: readonly ClassifiedReference[]): string {
  return references
    .map((reference) => `${reference.file}:${reference.line + 1}:${reference.character + 1} (${reference.kind})`)
    .join('\n  ');
}

export interface CallSiteSurvey {
  /** Every reference that is not the declaration or an import binding. */
  uses: ClassifiedReference[];
  /** References that are ordinary calls — the ones a rewrite can reach. */
  calls: ClassifiedReference[];
  /** References where the signature is checked by assignability. */
  escapes: ClassifiedReference[];
  /** Calls whose arguments are spread, so positions are a runtime fact. */
  spreads: ClassifiedReference[];
}

export function surveyCallSites(
  session: TsProjectSession,
  file: string,
  offset: number,
  calleeName: string,
): CallSiteSurvey {
  const references = classifyReferences(session, file, offset, {
    callable: new Set([calleeName]),
  });
  const uses = references.filter(isUse);
  return {
    uses,
    calls: uses.filter(
      (reference) => reference.kind === 'direct-call' || reference.kind === 'new',
    ),
    escapes: uses.filter(
      (reference) =>
        reference.kind !== 'direct-call' &&
        reference.kind !== 'new' &&
        reference.kind !== 'spread-call',
    ),
    spreads: uses.filter((reference) => reference.kind === 'spread-call'),
  };
}

/**
 * Refuse unless every use is a call this refactoring can rewrite.
 * `what` names the change, so the message says why it is unsafe here
 * rather than merely that it is.
 */
export function assertOnlyCalls(
  calleeName: string,
  survey: CallSiteSurvey,
  what: string,
): void {
  if (survey.escapes.length > 0) {
    throw new Error(
      `"${calleeName}" is not only called: at these references its signature is checked by ` +
        `assignability or rewritten by the caller, so ${what} would compile and misbehave:\n  ` +
        describeReferences(survey.escapes),
    );
  }
  if (survey.spreads.length > 0) {
    throw new Error(
      `"${calleeName}" is called with spread arguments, so which argument feeds which parameter ` +
        `is a runtime fact:\n  ${describeReferences(survey.spreads)}`,
    );
  }
}

/**
 * The call a reference forms, checked to be a call of this callable.
 * A reference that resolves elsewhere means the classifier and the
 * checker disagree, which is a refusal rather than something to guess
 * past.
 */
export function resolveCall(
  checker: ts.TypeChecker,
  reference: ClassifiedReference,
  callable: CallableDeclaration,
  calleeName: string,
): { call: ts.CallExpression | ts.NewExpression; sourceFile: ts.SourceFile; signature: ts.Signature } {
  const call = callLikeOf(reference.node);
  if (!call) {
    throw new Error(
      `Cannot find the call at ${reference.file}:${reference.line + 1}:${reference.character + 1}`,
    );
  }
  const sourceFile = call.getSourceFile();
  const signature = checker.getResolvedSignature(call);
  if (!signature || signature.declaration !== callable) {
    throw new Error(
      `The call at ${locationOf(sourceFile, call.getStart(sourceFile))} does not resolve to "${calleeName}"`,
    );
  }
  return { call, sourceFile, signature };
}

/**
 * Where `parameter` sits in the argument list of a resolved call —
 * not its index in the declaration, which `this` and overloads shift.
 */
export function argumentIndexOf(
  signature: ts.Signature,
  parameter: ts.ParameterDeclaration,
): number {
  return signature.parameters.findIndex((symbol) =>
    symbol.declarations?.some((declaration) => declaration === parameter),
  );
}
